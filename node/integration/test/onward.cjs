/*
    "People I trust, and onward" (PROJECT_PLAN's Contact tags, ruling 7, 2026-09-18): a
    sealed post whose author asked for the hop. Ada trusts bea; bea trusts cal; ada has
    never heard of cal. Ada's onward post opens for bea, who passes it along - a plain
    sealed post she may not. Cal, who follows bea, finds the share in his feed wearing the
    flag, and opens the words through bea's node, whose door releases the key on bea's
    trust; dana, who follows bea too but whom bea does not trust, is refused and never
    sees the card.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold, shareArrives } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)("onward: a sealed post that may be passed along", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, dana, danaRoot, post, plain;

    const meet = async (who, root, them, viaHost, band = "high") => {
        if ((await who(`api/id/${them}/profile?via=${await base58(viaHost)}`)).status !== 200) return false;
        await j(who, `api/identity/${root}/private/kv/contact:${them}/interest`, { value: band }, "PUT");
        return true;
    };
    const trust = async (host, who, root, them) => {
        await j(who, `api/identity/${root}/private/kv/contact:${them}/trust`, { value: "high" }, "PUT");
        await beat(host, "mint", root);
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
            if ((await who(path)).status === 200) return false;
            await wait(300);
        }
        return true;
    };
    const publish = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        return { status: pub.status, text: await pub.text(), doc: d.doc_id };
    };
    const feedRow = async (who, root, doc, tries = 20) => {
        for (let i = 0; i < tries; i++) {
            await shareArrives(HOST_C, beaRoot, adaRoot);
            for (let k = 0; k < 3; k++) await beat(HOST_C, "journal-fill");
            const feed = await (await who(`api/identity/${root}/feed`)).json();
            const row = (feed.items || []).find((p) => p.doc_id === doc);
            if (row) return row;
            await wait(400);
        }
        return null;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "onwada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "onwbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "onwcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        dana = await makeUserFetch({ prefix: "onwdana", host: HOST_C });
        danaRoot = (await (await dana("api/identity", { method: "POST" })).json()).root_pubkey;
        await dana(`api/identity/${danaRoot}/serve`, { method: "POST" });
        // Ada trusts bea; bea trusts cal; cal and dana follow bea, shares included. Ada never
        // meets cal or dana.
        if (!(await meet(bea, beaRoot, adaRoot, ada))) this.skip();
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await trust(HOST, ada, adaRoot, beaRoot);
        await pullAndFold(HOST, beaRoot);
        if (!(await meet(cal, calRoot, beaRoot, bea))) this.skip();
        if (!(await meet(dana, danaRoot, beaRoot, bea))) this.skip();
        await j(cal, `api/identity/${calRoot}/private/kv/contact:${beaRoot}/interest_rebroadcasts`, { value: "high" }, "PUT");
        await j(dana, `api/identity/${danaRoot}/private/kv/contact:${beaRoot}/interest_rebroadcasts`, { value: "high" }, "PUT");
        // The dials must be in the subscriptions memo before the share folds (sharedby.cjs's barrier).
        await beat(HOST_C, "fold", calRoot);
        await beat(HOST_C, "fold", danaRoot);
        await bea(`api/id/${calRoot}/profile?via=${await base58(cal)}`);
        await trust(HOST_B, bea, beaRoot, calRoot);
        await pullAndFold(HOST_B, calRoot);
        await pullAndFold(HOST_C, beaRoot);
        const made = await publish(ada, adaRoot, "the good bakery", "it's the one behind the station", { audience: "@onward" });
        assert.equal(made.status, 200, made.text);
        post = JSON.parse(made.text).post_id;
        const other = await publish(ada, adaRoot, "the bad bakery", "the one by the roundabout", { trusted_only: true });
        assert.equal(other.status, 200, other.text);
        plain = JSON.parse(other.text).post_id;
    });

    it("an onward post is sealed, and its header says so to everyone", async () => {
        const head = await (await ada(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.trusted_only, true, "sealed");
        assert.equal(head.onward, true, "and onward, off the header");
        assert.equal(head.title, "", "the title sealed like any sealed post");
        const shelf = (await (await ada(`api/id/${adaRoot}/posts?as=${adaRoot}`)).json()).posts || [];
        assert.equal((shelf.find((p) => p.doc_id === post) || {}).audience, undefined, "no audience memo: the list is the trust list");
        const other = await (await ada(`api/id/${adaRoot}/posts/${plain}`)).json();
        assert.equal(other.onward, undefined, "a plain sealed post is not onward");
    });

    it("the trusted reader opens it and passes it along; a plain sealed post she may not", async () => {
        await pullAndFold(HOST_B, adaRoot);
        assert.equal(await opens(bea, `id/${adaRoot}/docs/${post}/body`, 40), "it's the one behind the station", "bea, trusted, reads it");
        const shared = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, { author: adaRoot, doc_id: post });
        assert.equal(shared.status, 200, await shared.text());
        assert.equal(await opens(bea, `id/${adaRoot}/docs/${plain}/body`, 40), "the one by the roundabout", "she reads the plain one too");
        const refused = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, { author: adaRoot, doc_id: plain });
        assert.equal(refused.status, 400, "but a plain sealed post is not passed along");
        assert.match(await refused.text(), /not passed along/);
    });

    it("someone the sharer trusts finds the share in his feed and opens it through her node", async () => {
        await pullAndFold(HOST_C, beaRoot);
        const row = await feedRow(cal, calRoot, post);
        assert.ok(row, "the share reached cal's feed");
        assert.equal(row.onward, true, "wearing the flag");
        assert.equal(row.via, beaRoot, "by bea");
        assert.equal(
            await opens(cal, `id/${adaRoot}/docs/${post}/body?via=${beaRoot}`, 40),
            "it's the one behind the station",
            "cal, whom ada has never met, reads it on bea's word"
        );
        assert.equal(await opens(cal, `id/${adaRoot}/docs/${post}/body`, 5), "it's the one behind the station", "and again without the hint, on the grant his node remembers");
    });

    it("someone the sharer does not trust is refused, and never sees the card", async () => {
        assert.ok(await refusedSteadily(dana, `id/${adaRoot}/docs/${post}/body?via=${beaRoot}`), "dana follows bea, but bea does not trust her: no key");
        await shareArrives(HOST_C, beaRoot, adaRoot);
        for (let k = 0; k < 3; k++) await beat(HOST_C, "journal-fill");
        const feed = await (await dana(`api/identity/${danaRoot}/feed`)).json();
        assert.ok(!(feed.items || []).some((p) => p.doc_id === post), "and her feed hides the share");
    });
});
