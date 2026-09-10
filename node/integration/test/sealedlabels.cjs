/*
    Sealed labels (PROJECT_PLAN's Replies under the author's seal, ruling 7, 2026-09-10):
    every public statement about a sealed post rides the annotations lane as `sealed=<hex>`,
    the real statement encrypted under the post's key. A stranger's node folds ciphertext
    and serves no label; the author sees their tags; a trusted reader sees them once their
    node has opened the words; a trusted reader's own tag seals the same way and the author
    reads it; an untrusted labeller is refused at the door; a mention inside a sealed post
    notifies only someone the holder trusts; narrowing by a sealed tag works for the trusted.
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

(HOST_B && HOST_C ? describe : describe.skip)("sealed labels", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, post;

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
    const publish = async (who, root, title, body, tags, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        for (const t of tags) await who(`api/identity/${root}/docs/${d.doc_id}/annotations/tags/${t}`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        return { status: pub.status, text: await pub.text(), doc: d.doc_id };
    };
    const tagsFor = async (who, root, viewer) =>
        ((await (await who(`api/id/${root}/labels${viewer ? `?as=${viewer}` : ""}`)).json()).tags || []).map((t) => t.value);
    const tagsUntil = async (who, root, viewer, want, tries = 30) => {
        let got = [];
        for (let i = 0; i < tries; i++) {
            got = await tagsFor(who, root, viewer);
            if (want.every((w) => got.includes(w))) return got;
            await wait(400);
        }
        return got;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "lblada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "lblbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "lblcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        const sealed = await publish(ada, adaRoot, "the paperwork", "the family news", ["divorce"], { trusted_only: true });
        assert.equal(sealed.status, 200, sealed.text);
        post = JSON.parse(sealed.text).post_id;
        if (!(await meet(bea, beaRoot, adaRoot, ada))) this.skip();
        await trust(ada, adaRoot, beaRoot);
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await pullAndFold(HOST, beaRoot);
        if (!(await meet(cal, calRoot, adaRoot, ada, "low"))) this.skip();
    });

    it("the lane carries ciphertext: the author's own chain says `sealed`, never `tag`", async () => {
        const items = (await (await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}`)).json()).items || [];
        assert.ok(items.length >= 1, "something is said about the post");
        assert.ok(items.every((i) => i.key === "sealed" && /^[0-9a-f]+$/.test(i.value)), `every statement is sealed hex: ${JSON.stringify(items)}`);
    });

    it("the author sees the tag; a stranger's view of the same shelf has none", async () => {
        assert.deepEqual(await tagsUntil(ada, adaRoot, adaRoot, ["divorce"]), ["divorce"], "the author's node opened it as it folded");
        assert.deepEqual(await tagsFor(ada, adaRoot, null), [], "no viewer, no sealed label");
        await pullAndFold(HOST_C, adaRoot);
        assert.deepEqual(await tagsFor(cal, adaRoot, calRoot), [], "an untrusted reader's node holds only ciphertext");
    });

    it("a trusted reader sees the tag once their node has opened the words", async () => {
        await pullAndFold(HOST_B, adaRoot);
        assert.equal(await opens(bea, `id/${adaRoot}/docs/${post}/body`, 40), "the family news", "the trusted reader opens the post");
        assert.deepEqual(await tagsUntil(bea, adaRoot, beaRoot, ["divorce"]), ["divorce"], "the door opened the labels with the key");
        const narrowed = (await (await bea(`api/id/${adaRoot}/posts?tag=divorce&as=${beaRoot}`)).json()).posts || [];
        assert.deepEqual(narrowed.map((p) => p.doc_id), [post], "narrowing by the sealed tag works for the trusted");
        const blind = (await (await cal(`api/id/${adaRoot}/posts?tag=divorce&as=${calRoot}`)).json()).posts || [];
        assert.deepEqual(blind, [], "and finds nothing for a stranger");
    });

    it("a trusted reader's own tag seals the same way, the author reads it, and an untrusted labeller is refused", async () => {
        const r = await j(bea, `api/identity/${beaRoot}/public-annotations/${adaRoot}/${post}`, { key: "tag", value: "custody" }, "PUT");
        assert.equal(r.status, 200, await r.text());
        const said = (await (await bea(`api/identity/${beaRoot}/public-annotations/${adaRoot}/${post}`)).json()).items || [];
        assert.ok(said.every((i) => i.key === "sealed"), "bea's statement rides sealed");
        assert.deepEqual(await tagsUntil(bea, adaRoot, beaRoot, ["custody", "divorce"]).then((t) => t.sort()), ["custody", "divorce"], "bea sees both");
        for (let i = 0; i < 30; i++) {
            await pullAndFold(HOST, beaRoot);
            if ((await tagsFor(ada, adaRoot, adaRoot)).includes("custody")) break;
            await wait(400);
        }
        assert.deepEqual((await tagsFor(ada, adaRoot, adaRoot)).sort(), ["custody", "divorce"], "the author reads the trusted reader's tag");
        const no = await j(cal, `api/identity/${calRoot}/public-annotations/${adaRoot}/${post}`, { key: "tag", value: "gossip" }, "PUT");
        assert.equal(no.status, 403, await no.clone().text());
        assert.match(await no.text(), /can't label words you can't read/);
    });

    it("a mention inside a sealed post notifies the trusted and not the untrusted", async () => {
        const { speakable } = await import("../../js/speakable.js");
        const body = `news for [user id=/id/${speakable(beaRoot)}]bea[/user] and [user id=/id/${speakable(calRoot)}]cal[/user]`;
        const r = await publish(ada, adaRoot, "quietly", body, [], { trusted_only: true });
        assert.equal(r.status, 200, r.text);
        const mentioned = async (who, root) =>
            ((await (await who(`api/identity/${root}/notifications`)).json()).items || []).filter((i) => i.kind === "mentioned" && i.author === adaRoot);
        let got = [];
        for (let i = 0; i < 40 && !got.length; i++) {
            await beat(HOST, "outbox", adaRoot);
            await beat(HOST_B, "fold", beaRoot);
            got = await mentioned(bea, beaRoot);
            if (!got.length) await wait(400);
        }
        assert.equal(got.length, 1, "the trusted reader was told");
        await beat(HOST_C, "fold", calRoot);
        assert.deepEqual(await mentioned(cal, calRoot), [], "the untrusted reader was not");
    });
});
