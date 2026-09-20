/*
    The room post (CHAT.md, slice 1, 2026-09-18): a room is a post. Ada opens an open room
    and a sealed one; both list among her rooms and wear the `room` format on her shelf and
    in her feed's kind row. Bea, trusted and following, finds both in her rooms and enters
    the sealed one. Cal, a stranger who reached ada's page by link, enters the open room and
    is refused the sealed one; leaving forgets the link. The share rule is the post's own:
    the open room passes along, the sealed one does not.
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

(HOST_B && HOST_C ? describe : describe.skip)("rooms: a room is a post", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, kitchen, cellar;

    const openRoom = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        await who(`api/identity/${root}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, { room: true, ...extra });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return JSON.parse(text).post_id;
    };
    const rooms = async (who, root) => ((await (await who(`api/identity/${root}/rooms`)).json()).items || []);

    before(async function () {
        ada = await makeUserFetch({ prefix: "roomada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "roombea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "roomcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        // Bea follows ada and ada trusts her; cal is a stranger to everyone.
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        await pullAndFold(HOST, beaRoot);
        kitchen = await openRoom(ada, adaRoot, "the kitchen", "where the bread talk happens");
        cellar = await openRoom(ada, adaRoot, "the cellar", "the quiet one", { trusted_only: true });
    });

    it("a room wears its format everywhere the post shows, and lists among its author's rooms", async () => {
        const head = await (await ada(`api/id/${adaRoot}/posts/${kitchen}`)).json();
        assert.equal(head.format, "room", "the shelf says room");
        assert.equal(head.title, "the kitchen");
        const sealed = await (await ada(`api/id/${adaRoot}/posts/${cellar}?as=${adaRoot}`)).json();
        assert.equal(sealed.format, "room");
        assert.equal(sealed.trusted_only, true, "a sealed room is a sealed post");
        assert.equal(sealed.title, "", "whose name travels with its words");
        const mine = await rooms(ada, adaRoot);
        const ids = mine.map((r) => r.doc_id);
        assert.ok(ids.includes(kitchen) && ids.includes(cellar), `both rooms list: ${JSON.stringify(mine)}`);
        assert.ok(mine.every((r) => r.mine), "and they are hers");
        // The kind row knows the word.
        let kinds = [];
        for (let i = 0; i < 20 && !kinds.includes("room"); i++) {
            await beat(HOST, "journal-fill");
            const labels = await (await ada(`api/identity/${adaRoot}/feed/labels`)).json();
            kinds = (labels.kinds || []).map((k) => k.value);
            if (!kinds.includes("room")) await wait(300);
        }
        assert.ok(kinds.includes("room"), `the feed's kind row lists rooms: ${kinds}`);
    });

    it("a room is not a reply, and a room stays a room when its words change", async () => {
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "no", body: "no", format: "marquee" })).json();
        const r = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, { room: true, reply_to: { author: adaRoot, doc_id: kitchen } });
        assert.equal(r.status, 400, await r.text());
        // Re-publishing the draft without the flag keeps the format: once a room, always a room.
        const docs = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs || [];
        const kitchenDraft = docs.find((x) => x.title === "the kitchen");
        assert.ok(kitchenDraft, "the room's draft is a note in the chat bucket");
        const got = await (await ada(`api/identity/${adaRoot}/docs/${kitchenDraft.doc_id}`)).json();
        const put = await j(ada, `api/identity/${adaRoot}/docs/${kitchenDraft.doc_id}`, { title: got.title, body: "where the bread talk happens, loudly", parents: got.heads.map((h) => h.version), format: "marquee" }, "PUT");
        assert.equal(put.status, 200, await put.text());
        const again = await j(ada, `api/identity/${adaRoot}/docs/${kitchenDraft.doc_id}/publish`, {});
        assert.equal(again.status, 200, await again.text());
        const head = await (await ada(`api/id/${adaRoot}/posts/${kitchen}`)).json();
        assert.equal(head.format, "room", "still a room");
    });

    it("a trusted follower finds both rooms and enters the sealed one", async () => {
        await pullAndFold(HOST_B, adaRoot);
        let hers = [];
        for (let i = 0; i < 30 && !(hers.some((r) => r.doc_id === kitchen) && hers.some((r) => r.doc_id === cellar)); i++) {
            for (let k = 0; k < 3; k++) await beat(HOST_B, "journal-fill");
            hers = await rooms(bea, beaRoot);
            if (hers.length < 2) await wait(400);
        }
        assert.ok(hers.some((r) => r.doc_id === kitchen), "the open room reached her list by the feed");
        assert.ok(hers.some((r) => r.doc_id === cellar), "and the sealed one, since ada trusts her");
        assert.ok(hers.every((r) => !r.mine), "neither is hers");
        let entered = null;
        for (let i = 0; i < 30 && !entered; i++) {
            const r = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${cellar}`);
            if (r.status === 200) entered = await r.json();
            else await wait(400);
        }
        assert.ok(entered, "the door admits her");
        assert.equal(entered.joined, true);
        assert.equal(entered.trusted_only, true);
    });

    it("the creator tags a room, and the tags ride it into everyone's list - a sealed room's only to those it admits", async () => {
        const tagsOf = async (who, root, doc) => ((await rooms(who, root)).find((r) => r.doc_id === doc) || {}).tags || [];
        for (const [doc, value] of [[kitchen, "bread"], [kitchen, "baking"], [cellar, "secret"]]) {
            const put = await j(ada, `api/identity/${adaRoot}/public-annotations/${adaRoot}/${doc}`, { key: "tag", value }, "PUT");
            assert.equal(put.status, 200, await put.text());
        }
        assert.deepEqual(await tagsOf(ada, adaRoot, kitchen), ["baking", "bread"], "her own list wears them, sorted");
        assert.deepEqual(await tagsOf(ada, adaRoot, cellar), ["secret"], "the sealed room's too, for its author");
        // Bea, trusted: both rooms' tags reach her, the sealed one's through the seal.
        let hers = [];
        for (let i = 0; i < 30; i++) {
            await pullAndFold(HOST_B, adaRoot);
            hers = await tagsOf(bea, beaRoot, kitchen);
            if (hers.length === 2) break;
            await wait(300);
        }
        assert.deepEqual(hers, ["baking", "bread"], `the open room's tags reached bea: ${JSON.stringify(hers)}`);
        let sealed = [];
        for (let i = 0; i < 30; i++) {
            await pullAndFold(HOST_B, adaRoot);
            sealed = await tagsOf(bea, beaRoot, cellar);
            if (sealed.length === 1) break;
            await wait(300);
        }
        assert.deepEqual(sealed, ["secret"], `the sealed room's tags open for a reader it admits: ${JSON.stringify(sealed)}`);
    });

    it("a stranger enters the open room by link, is refused the sealed one, and can leave", async () => {
        const seen = await cal(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
        if (seen.status !== 200) this.skip();
        let open = null;
        for (let i = 0; i < 30 && !open; i++) {
            const r = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${kitchen}`);
            if (r.status === 200) open = await r.json();
            else await wait(400);
        }
        assert.ok(open, "an open room admits anyone who can see the post");
        assert.equal(open.joined, true);
        const refused = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${cellar}`);
        const words = await refused.text();
        assert.equal(refused.status, 403, words);
        assert.match(words, /sealed/);
        let his = await rooms(cal, calRoot);
        assert.ok(his.some((r) => r.doc_id === kitchen && r.joined), "the room he entered lists, joined by link");
        assert.ok(!his.some((r) => r.doc_id === cellar), "the sealed one does not");
        const left = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${kitchen}`, { method: "DELETE" });
        assert.equal(left.status, 200, await left.text());
        his = await rooms(cal, calRoot);
        // Left, not forgotten (Curtis, 2026-09-19): the room lists beneath the active ones,
        // no longer joined, until rejoined.
        const gone = his.find((r) => r.doc_id === kitchen);
        assert.ok(gone && gone.left && !gone.joined, `leaving keeps the room, marked left: ${JSON.stringify(gone)}`);
    });

    it("the share rule is the post's own: the open room passes along, the sealed one does not", async () => {
        const ok = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, { author: adaRoot, doc_id: kitchen });
        assert.equal(ok.status, 200, await ok.text());
        const no = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, { author: adaRoot, doc_id: cellar });
        assert.equal(no.status, 400, await no.text());
    });
});
