/*
    "Only show to the people mentioned" (PROJECT_PLAN's Contact tags, ruling 5, 2026-09-14):
    a post sealed to the roots its user cards name - a private thread among named people,
    on features the seal already had. Ada trusts bea, cal and dana; her post names bea and
    cal and is for the people mentioned: both open it, bea's reply reaches cal, dana - trusted
    but unnamed - is refused the post and the reply and is told the thread is sealed; a post
    for the people mentioned that mentions nobody is refused at publish.
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

(HOST_B && HOST_C ? describe : describe.skip)("messages: a post for the people mentioned", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, dana, danaRoot, post, reply, speakable;

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

    before(async function () {
        ({ speakable } = await import("../../js/speakable.js"));
        ada = await makeUserFetch({ prefix: "msgada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "msgbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "msgcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        dana = await makeUserFetch({ prefix: "msgdana", host: HOST_C });
        danaRoot = (await (await dana("api/identity", { method: "POST" })).json()).root_pubkey;
        await dana(`api/identity/${danaRoot}/serve`, { method: "POST" });
        for (const [who, root] of [[bea, beaRoot], [cal, calRoot], [dana, danaRoot]]) {
            if (!(await meet(who, root, adaRoot, ada))) this.skip();
            await trust(ada, adaRoot, root);
        }
        for (const [who, root] of [[bea, beaRoot], [cal, calRoot], [dana, danaRoot]]) {
            await ada(`api/id/${root}/profile?via=${await base58(who)}`);
            await pullAndFold(HOST, root);
        }
    });

    it("a post for the people mentioned needs somebody mentioned", async () => {
        const r = await publish(ada, adaRoot, "to nobody", "just thinking aloud", { audience: "@mentioned" });
        assert.equal(r.status, 400, r.text);
        assert.match(r.text, /mention someone first/);
    });

    it("the named people open it; the author's card says who it is for", async () => {
        const words = `[user id=/id/${speakable(beaRoot)}]bea[/user], [user id=/id/${speakable(calRoot)}]cal[/user]: lunch thursday?`;
        const made = await publish(ada, adaRoot, "lunch", words, { audience: "@mentioned" });
        assert.equal(made.status, 200, made.text);
        post = JSON.parse(made.text).post_id;
        const shelf = (await (await ada(`api/id/${adaRoot}/posts?as=${adaRoot}`)).json()).posts || [];
        assert.equal((shelf.find((p) => p.doc_id === post) || {}).audience, "@mentioned");
        await pullAndFold(HOST_B, adaRoot);
        await pullAndFold(HOST_C, adaRoot);
        assert.ok((await opens(bea, `id/${adaRoot}/docs/${post}/body`, 40)) !== null, "bea, named, opens it");
        assert.ok((await opens(cal, `id/${adaRoot}/docs/${post}/body`, 40)) !== null, "cal, named, opens it");
    });

    it("a reply stays in the room: bea answers and cal reads it", async () => {
        const r = await publish(bea, beaRoot, "", "thursday works", { reply_to: { author: adaRoot, doc_id: post } });
        assert.equal(r.status, 200, r.text);
        reply = JSON.parse(r.text).post_id;
        await cal(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await pullAndFold(HOST_C, beaRoot);
        assert.equal(await opens(cal, `id/${beaRoot}/docs/${reply}/body?via=${beaRoot}`, 40), "thursday works", "cal reads bea's reply under ada's seal");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await pullAndFold(HOST, beaRoot);
        assert.equal(await opens(ada, `id/${beaRoot}/docs/${reply}/body`, 40), "thursday works", "and so does ada");
    });

    it("someone trusted but unnamed is outside the room", async () => {
        await pullAndFold(HOST_C, adaRoot);
        assert.ok(await refusedSteadily(dana, `id/${adaRoot}/docs/${post}/body`), "dana is trusted, not named: no key");
        assert.ok(await refusedSteadily(dana, `id/${beaRoot}/docs/${reply}/body?via=${beaRoot}`), "nor bea's reply");
        const thread = await (await dana(`api/id/${adaRoot}/posts/${post}/replies?as=${danaRoot}`)).json();
        assert.equal(thread.sealed, true, "the thread door says sealed");
        const shelf = await (await dana(`api/id/${adaRoot}/posts?as=${danaRoot}`)).json();
        assert.ok(!(shelf.posts || []).some((p) => p.doc_id === post), "and the shelf hides it");
    });
});
