/*
    A room while its creator's node is off (Curtis, 2026-09-29: "If User A's computer is turned off
    entirely and User B and User C want to have a conversation in the room: can they?"). CHAT.md,
    ruling 4: every participant mirrors every other's chain, so nothing depends on one node being
    up - the creator's node is the directory of record, not the only road. Ada opens a room; bea and
    cal each say something while ada's node is up; then ada's node goes dark, and bea and cal go on
    talking, each reading the other's words off the other's own node.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");
const { withUnplugged } = require("./unplug.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)("a room while its creator's node is off", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, room;

    const say = async (who, root, words) => {
        const r = await j(who, `api/identity/${root}/rooms/${adaRoot}/${room}/messages`, { words });
        assert.equal(r.status, 200, await r.text());
    };
    const wordsOf = (h) => (h.items || []).map((m) => m.words);
    // The reader's node pulls the room and folds what landed, then reads.
    const reads = async (host, who, root, want, tries = 30) => {
        let h = { items: [] };
        for (let i = 0; i < tries; i++) {
            await who(`api/identity/${root}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            for (const speaker of [adaRoot, beaRoot, calRoot]) await beat(host, "fold", speaker);
            h = await (await who(`api/identity/${root}/rooms/${adaRoot}/${room}/messages`)).json();
            if (want.every((w) => wordsOf(h).includes(w))) return h;
            await wait(400);
        }
        return h;
    };
    const enter = async (who, root) => {
        for (let i = 0; i < 30; i++) {
            if ((await who(`api/identity/${root}/rooms/${adaRoot}/${room}`)).status === 200) return true;
            await wait(400);
        }
        return false;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "darkada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "darkbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "darkcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });

        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "the porch", body: "sit a while", format: "marquee" })).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, { room: true });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        room = JSON.parse(text).post_id;

        // Both reach the room by link, as anyone does, and each says a word while ada is up.
        const viaAda = await base58(ada);
        for (const [who, root] of [[bea, beaRoot], [cal, calRoot]]) {
            if ((await who(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
            assert.ok(await enter(who, root), "in the room");
        }
        await say(bea, beaRoot, "bea is here");
        await say(cal, calRoot, "cal is here");
        const onBea = await reads(HOST_B, bea, beaRoot, ["bea is here", "cal is here"]);
        assert.ok(wordsOf(onBea).includes("cal is here"), `bea hears cal while ada is up: ${JSON.stringify(wordsOf(onBea))}`);
        const onCal = await reads(HOST_C, cal, calRoot, ["bea is here", "cal is here"]);
        assert.ok(wordsOf(onCal).includes("bea is here"), `cal hears bea while ada is up: ${JSON.stringify(wordsOf(onCal))}`);
    });

    it("with ada's node dark, bea and cal still hear each other", async () => {
        await withUnplugged([HOST], async () => {
            await say(bea, beaRoot, "ada is asleep");
            const onCal = await reads(HOST_C, cal, calRoot, ["ada is asleep"]);
            assert.ok(wordsOf(onCal).includes("ada is asleep"), `cal hears bea with ada dark: ${JSON.stringify(wordsOf(onCal))}`);
            await say(cal, calRoot, "let her sleep");
            const onBea = await reads(HOST_B, bea, beaRoot, ["let her sleep"]);
            assert.ok(wordsOf(onBea).includes("let her sleep"), `bea hears cal with ada dark: ${JSON.stringify(wordsOf(onBea))}`);
        });
    });

    // The newcomer (Curtis, 2026-09-29): to know whom to ask with the creator dark she would need
    // the room's history, which she doesn't have - "just keeping track of the last 20-50 people
    // to post in a room should be loads for anybody to get bootstrapped". Eve follows ada, so the
    // room is in her feed; she never enters it. While ada's node is up, eve's node learns the
    // room's recent speakers on the pulse it already makes; then ada's node goes dark, and eve
    // enters the room and reads it off bea's and cal's nodes.
    it("a newcomer who never entered finds the room's recent speakers, and reads them with ada's node dark", async function () {
        if (!HOST_E) this.skip();
        const eve = await makeUserFetch({ prefix: "darkeve", host: HOST_E });
        const eveRoot = (await (await eve("api/identity", { method: "POST" })).json()).root_pubkey;
        await eve(`api/identity/${eveRoot}/serve`, { method: "POST" });
        if ((await eve(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(eve, `api/identity/${eveRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        let inFeed = false;
        for (let i = 0; i < 30 && !inFeed; i++) {
            await pullAndFold(HOST_E, adaRoot);
            inFeed = ((await (await eve(`api/identity/${eveRoot}/feed`)).json()).items || []).some((r) => r.doc_id === room);
            if (!inFeed) await wait(400);
        }
        assert.ok(inFeed, "the room is in eve's feed");
        await beat(HOST_E, "room-pulse");
        await withUnplugged([HOST], async () => {
            assert.ok(await enter(eve, eveRoot), "eve enters the room with ada's node dark");
            const floor = await reads(HOST_E, eve, eveRoot, ["cal is here", "let her sleep"]);
            assert.ok(
                wordsOf(floor).includes("cal is here") && wordsOf(floor).includes("let her sleep"),
                `eve reads the room off bea's and cal's nodes: ${JSON.stringify(wordsOf(floor))}`
            );
        });
    });
});
