/*
    The audience (PROJECT_PLAN's Contact tags, ruling 4, 2026-09-10): a post sealed to a
    contact tag - "family" - rather than to everyone the author trusts. Ada trusts bea AND
    cal, and tags only bea "family". Her family post opens for bea, who replies under its
    seal; cal, trusted but not family, cannot open the post or the reply, sees neither on
    ada's shelf nor in his own feed once his node has been refused the key, and the thread
    tells him it is sealed. A stranger sees nothing at all.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)("the audience: a post sealed to a contact tag", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, post, reply;

    const meet = async (who, root, them, viaHost, band = "high") => {
        if ((await who(`api/id/${them}/profile?via=${await base58(viaHost)}`)).status !== 200) return false;
        await j(who, `api/identity/${root}/private/kv/contact:${them}/interest`, { value: band }, "PUT");
        return true;
    };
    const trust = async (who, root, them) => {
        await j(who, `api/identity/${root}/private/kv/contact:${them}/trust`, { value: "high" }, "PUT");
        await beat(HOST, "mint", root);
    };
    const opens = async (who, path, tries = 30) => {
        for (let i = 0; i < tries; i++) {
            const r = await who(path);
            if (r.status === 200) return r.text();
            await wait(400);
        }
        return null;
    };
    const refusedSteadily = async (who, path, tries = 6) => {
        for (let i = 0; i < tries; i++) {
            const r = await who(path);
            if (r.status === 200) return false;
            await wait(300);
        }
        return true;
    };
    const publish = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        return { status: pub.status, text: await pub.text(), doc: d.doc_id };
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "audada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "audbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "audcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        if (!(await meet(bea, beaRoot, adaRoot, ada))) this.skip();
        if (!(await meet(cal, calRoot, adaRoot, ada))) this.skip();
        // Ada trusts both; only bea is family.
        await trust(ada, adaRoot, beaRoot);
        await trust(ada, adaRoot, calRoot);
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/tags`, { value: '["family"]' }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await ada(`api/id/${calRoot}/profile?via=${await base58(cal)}`);
        await pullAndFold(HOST, beaRoot);
        await pullAndFold(HOST, calRoot);
        const made = await publish(ada, adaRoot, "the reunion", "grandma is coming after all", { audience: "family" });
        assert.equal(made.status, 200, made.text);
        post = JSON.parse(made.text).post_id;
    });

    it("an audience is a sealed post, and the author's node knows who it is for", async () => {
        const head = await (await ada(`api/id/${adaRoot}/posts/${post}?as=${adaRoot}`)).json();
        assert.equal(head.trusted_only, true, "sealed without being asked to be");
        assert.equal(head.title, "", "and its title is sealed like any sealed post");
        const shelf = (await (await ada(`api/id/${adaRoot}/posts?as=${adaRoot}`)).json()).posts || [];
        assert.equal((shelf.find((p) => p.doc_id === post) || {}).audience, "family", "the author's own shelf names the list");
        const feed = (await (await ada(`api/identity/${adaRoot}/feed`)).json()).items || [];
        const mine = feed.find((p) => p.doc_id === post);
        if (mine) assert.equal(mine.audience, "family", "and so does her feed card");
        assert.equal(await opens(ada, `id/${adaRoot}/docs/${post}/body`), "grandma is coming after all", "the author reads it");
    });

    it("the family member opens it and replies under its seal", async () => {
        await pullAndFold(HOST_B, adaRoot);
        assert.equal(await opens(bea, `id/${adaRoot}/docs/${post}/body`, 40), "grandma is coming after all", "bea, family, gets the key");
        const r = await publish(bea, beaRoot, "", "I'll bring the good chairs", { reply_to: { author: adaRoot, doc_id: post } });
        assert.equal(r.status, 200, r.text);
        reply = JSON.parse(r.text).post_id;
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await pullAndFold(HOST, beaRoot);
        assert.equal(await opens(ada, `id/${beaRoot}/docs/${reply}/body`, 40), "I'll bring the good chairs", "the author reads the reply with the key that was hers");
        let thread = { replies: [] };
        for (let i = 0; i < 30 && !thread.replies.some((x) => x.doc_id === reply); i++) {
            thread = await (await ada(`api/id/${adaRoot}/posts/${post}/replies?as=${adaRoot}`)).json();
            if (!thread.replies.some((x) => x.doc_id === reply)) await wait(400);
        }
        assert.ok(thread.replies.some((x) => x.doc_id === reply), "and the reply is in her thread");
    });

    it("a trusted reader outside the audience cannot open the post or the reply, and is told the thread is sealed", async () => {
        await pullAndFold(HOST_C, adaRoot);
        await cal(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await pullAndFold(HOST_C, beaRoot);
        assert.ok(await refusedSteadily(cal, `id/${adaRoot}/docs/${post}/body`), "cal is trusted, not family: no key, no words");
        assert.ok(await refusedSteadily(cal, `id/${beaRoot}/docs/${reply}/body?via=${beaRoot}`), "nor the reply, sealed under the same key");
        const thread = await (await cal(`api/id/${adaRoot}/posts/${post}/replies?as=${calRoot}`)).json();
        assert.equal(thread.sealed, true, "the thread door says sealed");
        assert.deepEqual(thread.replies, [], "and serves nothing");
    });

    it("the post is not on ada's shelf for cal, and drops out of cal's feed once his node was refused the key", async () => {
        const shelf = await (await cal(`api/id/${adaRoot}/posts?as=${calRoot}`)).json();
        assert.ok(!(shelf.posts || []).some((p) => p.doc_id === post), "ada's node hides it from cal");
        const own = await (await ada(`api/id/${adaRoot}/posts?as=${calRoot}`)).json();
        assert.ok(!(own.posts || []).some((p) => p.doc_id === post), "asked of ada's own node, the same");
        let gone = false;
        for (let i = 0; i < 20 && !gone; i++) {
            for (let k = 0; k < 3; k++) await beat(HOST_C, "journal-fill");
            const feed = await (await cal(`api/identity/${calRoot}/feed`)).json();
            gone = !(feed.items || []).some((p) => p.doc_id === post);
            if (!gone) await wait(400);
        }
        assert.ok(gone, "cal's feed hides what the door refused");
    });

    it("a stranger sees nothing at all", async () => {
        const dana = await makeUserFetch({ prefix: "auddana" });
        const danaRoot = (await (await dana("api/identity", { method: "POST" })).json()).root_pubkey;
        const shelf = await (await dana(`api/id/${adaRoot}/posts?as=${danaRoot}`)).json();
        assert.ok(!(shelf.posts || []).some((p) => p.doc_id === post));
        assert.notEqual((await dana(`id/${adaRoot}/docs/${post}/body`)).status, 200);
    });
});
