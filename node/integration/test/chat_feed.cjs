/*
    A room in the feed (Curtis, 2026-09-18): a room takes no replies and does not copy into
    notes - the conversation is inside it - and a busy room cycles in the feed: its feed
    time is its last word's, moved by the room pulse rather than per word. A reader who only
    follows the creator, never entered the room, still sees it move: the pulse asks the
    creator's node for the newest line.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("a room in the feed: no replies, no copies, and a busy room cycles", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, room, later;

    const publish = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        await who(`api/identity/${root}/docs/${d.doc_id}/buckets/${extra.room ? "chat" : "feed"}`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return { post: JSON.parse(text).post_id, draft: d.doc_id };
    };
    const feed = async (who, root) => ((await (await who(`api/identity/${root}/feed`)).json()).items || []);
    const feedRow = async (who, root, doc, tries = 30) => {
        for (let i = 0; i < tries; i++) {
            const row = (await feed(who, root)).find((r) => r.doc_id === doc);
            if (row) return row;
            await pullAndFold(HOST_B, adaRoot);
            await wait(300);
        }
        return null;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "feedada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "feedbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        ({ post: room } = await publish(ada, adaRoot, "the parlour", "where the talk is", { room: true }));
        await wait(20);
        ({ post: later } = await publish(ada, adaRoot, "a later word", "said after the room opened"));
        await pullAndFold(HOST_B, adaRoot);
    });

    it("a room takes no replies, and does not copy into notes", async () => {
        const d = await (await j(bea, `api/identity/${beaRoot}/docs`, { title: "", body: "a reply to the room", format: "marquee" })).json();
        await bea(`api/identity/${beaRoot}/docs/${d.doc_id}/buckets/feed`, { method: "PUT" });
        const reply = await j(bea, `api/identity/${beaRoot}/docs/${d.doc_id}/publish`, { reply_to: { author: adaRoot, doc_id: room } });
        assert.equal(reply.status, 400, await reply.text());
        const copy = await j(bea, `api/identity/${beaRoot}/docs/copy`, { author: adaRoot, doc_id: room, bucket: "clippings", new: true });
        assert.equal(copy.status, 400, await copy.text());
    });

    it("a busy room cycles in the feed: its feed time becomes its last word's, by the pulse, without entering it", async () => {
        const before = await feedRow(bea, beaRoot, room);
        assert.ok(before, "the room is in bea's feed");
        const laterRow = await feedRow(bea, beaRoot, later);
        assert.ok(laterRow, "and so is the later post");
        assert.ok(laterRow.published_ms >= before.published_ms, "the later post sits above the room at first");
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "is anyone about?" });
        const saidText = await said.text();
        assert.equal(said.status, 200, saidText);
        const saidMs = JSON.parse(saidText).said_ms;
        assert.ok(saidMs > laterRow.published_ms, "the word came after the later post");
        // Bea never entered the room: her node holds none of its chains, and the pulse asks
        // ada's node for the newest line.
        await beat(HOST_B, "room-pulse");
        const after = await feedRow(bea, beaRoot, room);
        assert.equal(after.published_ms, saidMs, `the room's feed time is its last word's: ${JSON.stringify(after)}`);
        const items = await feed(bea, beaRoot);
        const roomAt = items.findIndex((r) => r.doc_id === room);
        const laterAt = items.findIndex((r) => r.doc_id === later);
        assert.ok(roomAt >= 0 && roomAt < laterAt, "the room now sits above the later post");
        // The card's tail: the last three lines, newest first, with when.
        for (const w of ["two", "three", "four"]) {
            const r = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: w });
            assert.equal(r.status, 200, await r.text());
            await wait(5);
        }
        const tail = await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages?limit=3`)).json();
        assert.deepEqual((tail.items || []).map((m) => m.words), ["four", "three", "two"], `the tail is the last three: ${JSON.stringify(tail)}`);
        assert.ok(tail.items.every((m) => m.said_ms > 0), "each with when");
        assert.equal(tail.total, 4, `and the room's size, for "and N more": ${JSON.stringify(tail)}`);
    });
});
