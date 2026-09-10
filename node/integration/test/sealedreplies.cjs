/*
    Replies under the author's seal (PROJECT_PLAN, 2026-09-08): a reply to a sealed post is
    sealed under the PARENT's key, so whoever the author trusts reads the whole conversation
    and nobody else reads any of it - the commenter's own followers included. A replier who
    never could read the parent is refused; a picture in such a reply is refused for now.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch, makePng } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)("replies under the author's seal", function () {
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
    const publish = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        return { status: pub.status, text: await pub.text(), doc: d.doc_id };
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "sealada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "sealbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "sealcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        const sealed = await publish(ada, adaRoot, "for my people", "the family news", { trusted_only: true });
        assert.equal(sealed.status, 200, sealed.text);
        post = JSON.parse(sealed.text).post_id;
        // bea follows ada and is trusted; cal follows bea only, and ada does not trust cal.
        if (!(await meet(bea, beaRoot, adaRoot, ada))) this.skip();
        await trust(ada, adaRoot, beaRoot);
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await pullAndFold(HOST, beaRoot);
        await pullAndFold(HOST_B, adaRoot);
        assert.equal((await opens(bea, `id/${adaRoot}/docs/${post}/body`, 40)), "the family news", "the trusted reader opens the parent");
        if (!(await meet(cal, calRoot, beaRoot, bea))) this.skip();
    });

    it("a reader the author does not trust cannot reply at all", async () => {
        if (!(await meet(cal, calRoot, adaRoot, ada, "low"))) this.skip();
        await pullAndFold(HOST_C, adaRoot);
        const r = await publish(cal, calRoot, "", "what news?", { reply_to: { author: adaRoot, doc_id: post } });
        assert.equal(r.status, 400, r.text);
        assert.match(r.text, /doesn't share with you/);
    });

    it("the trusted reader's reply is sealed under the parent's key, with no wish of its own", async () => {
        const r = await publish(bea, beaRoot, "", "so glad she is home", { reply_to: { author: adaRoot, doc_id: post } });
        assert.equal(r.status, 200, r.text);
        reply = JSON.parse(r.text).post_id;
        const head = await (await bea(`api/id/${beaRoot}/posts/${reply}?as=${beaRoot}`)).json();
        assert.equal(head.trusted_only, true, "sealed, though bea asked for nothing");
        assert.equal(await opens(bea, `id/${beaRoot}/docs/${reply}/body`), "so glad she is home", "bea reads her own reply");
    });

    it("the author reads the reply with the key that was theirs all along", async () => {
        await pullAndFold(HOST, beaRoot);
        assert.equal(await opens(ada, `id/${beaRoot}/docs/${reply}/body?via=${beaRoot}`, 40), "so glad she is home");
    });

    it("the commenter's own follower, untrusted by the author, sees nothing: not on the shelf, not in the feed, not in the thread, not at the door", async () => {
        await pullAndFold(HOST_C, beaRoot);
        const shelf = await (await cal(`api/id/${beaRoot}/posts?as=${calRoot}`)).json();
        assert.ok(!(shelf.posts || []).some((p) => p.doc_id === reply), "bea's shelf hides it from cal");
        for (let i = 0; i < 5; i++) await beat(HOST_C, "journal-fill");
        const feed = await (await cal(`api/identity/${calRoot}/feed`)).json();
        assert.ok(!(feed.items || []).some((p) => p.doc_id === reply), "cal's feed hides it");
        const thread = await (await cal(`api/id/${adaRoot}/posts/${post}/replies?as=${calRoot}`)).json();
        assert.equal(thread.sealed, true, "the thread says the conversation is sealed");
        assert.deepEqual(thread.replies, []);
        assert.equal((await cal(`id/${beaRoot}/docs/${reply}/body?via=${beaRoot}`)).status, 403, "and the door refuses");
    });

    it("once the author trusts that follower, the same reply opens for them - the author's gate, never the commenter's", async () => {
        await trust(ada, adaRoot, calRoot);
        await ada(`api/id/${calRoot}/profile?via=${await base58(cal)}`);
        await pullAndFold(HOST, calRoot);
        await pullAndFold(HOST_C, adaRoot);
        assert.equal((await opens(cal, `id/${adaRoot}/docs/${post}/body`, 40)), "the family news", "the parent opens");
        assert.equal(await opens(cal, `id/${beaRoot}/docs/${reply}/body?via=${beaRoot}`, 40), "so glad she is home", "and so does the reply");
    });

    it("a picture in a sealed reply wears the author's seal too: the header names whose, and an untrusted follower is refused", async () => {
        const up = await (await bea(`api/identity/${beaRoot}/docs/binary?title=plate`, { method: "POST", body: makePng(24, 24), file: true })).json();
        for (let i = 0; i < 100; i++) {
            if ((await bea(`api/identity/${beaRoot}/docs/${up.doc_id}/body`)).status === 200) break;
            await wait(400);
        }
        let pictured = null;
        for (let i = 0; i < 40 && !pictured; i++) {
            const r = await publish(bea, beaRoot, "", `look\n\n![p](/api/identity/${beaRoot}/docs/${up.doc_id}/body/p.avif)`, { reply_to: { author: adaRoot, doc_id: post } });
            if (r.status === 200 && JSON.parse(r.text).post_id) pictured = JSON.parse(r.text).post_id;
            else await wait(500);
        }
        assert.ok(pictured, "the pictured reply published");
        const head = await (await bea(`api/id/${beaRoot}/posts/${pictured}?as=${beaRoot}`)).json();
        assert.equal(head.trusted_only, true, "sealed like its parent");
        const twin = (head.refs || [])[0];
        assert.ok(twin, "the reply names its picture's twin");
        // The twin wears ada's seal, not bea's: dana follows bea and ada does not trust her.
        const dana = await makeUserFetch({ prefix: "sealdana", host: HOST_C });
        const danaRoot = (await (await dana("api/identity", { method: "POST" })).json()).root_pubkey;
        await dana(`api/identity/${danaRoot}/serve`, { method: "POST" });
        if (!(await meet(dana, danaRoot, beaRoot, bea))) this.skip();
        await pullAndFold(HOST_C, beaRoot);
        assert.notEqual((await dana(`id/${beaRoot}/docs/${twin}/body?via=${beaRoot}`)).status, 200, "bea's own follower cannot open the picture");
        assert.notEqual((await dana(`id/${beaRoot}/docs/${pictured}/body?via=${beaRoot}`)).status, 200, "nor the words");
        // cal, whom ada trusts by now, opens both.
        assert.ok(await opens(cal, `id/${beaRoot}/docs/${pictured}/body?via=${beaRoot}`, 40), "the author's trusted reader opens the reply");
        const pic = await opens(cal, `id/${beaRoot}/docs/${twin}/body?via=${beaRoot}`, 40);
        assert.ok(pic, "and its picture");
    });
});
