/*
    History (CHAT.md, slice 4, 2026-09-18): the creator's node is the room's archive, every
    other node keeps a budget. Ada says more than the budget in her room; bea, a trusted
    follower on another node, pulls it and her node keeps only the newest eight, yet her
    floor reads the whole room - the page beneath what she keeps comes from ada's node over
    the fragment lane, verified line by line. Full-sync is the operator's button: bea's node
    admin presses it, her node walks ada's chain down to its beginning and keeps the room
    whole from then on; released, the budget applies again.

    The rig runs every node with RINGTOME_TEST_ROOM_BUDGET=8 (justfile).
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, sql } = require("./fetch.cjs");

const BUDGET = 8;
const LINES = 12;

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const esc = (s) => s.replace(/'/g, "''");

(HOST_B ? describe : describe.skip)("chat history: the archive and the budget", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, room;

    const say = async (who, root, author, doc, words) => j(who, `api/identity/${root}/rooms/${author}/${doc}/messages`, { words });
    const history = async (who, root, author, doc, query = "") => (await (await who(`api/identity/${root}/rooms/${author}/${doc}/messages${query}`)).json());
    const wordsOf = (h) => (h.items || []).map((m) => m.words);
    const held = async (host) => {
        const r = await sql(`SELECT COUNT(*) AS n FROM room_messages WHERE room_author = '${esc(adaRoot)}' AND room_doc = '${esc(room)}'`, host);
        return Number(r.rows[0].n);
    };
    const readAfterSync = async (host, who, root, want, tries = 30) => {
        let h = { items: [] };
        for (let i = 0; i < tries; i++) {
            await who(`api/identity/${root}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(host, "fold", adaRoot);
            h = await history(who, root, adaRoot, room);
            if (want.every((w) => wordsOf(h).includes(w))) return h;
            await wait(400);
        }
        return h;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "histada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "histbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        await pullAndFold(HOST, beaRoot);
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "the long room", body: "where the talk runs long", format: "marquee" })).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, { room: true });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        room = JSON.parse(text).post_id;
        for (let i = 1; i <= LINES; i++) {
            const r = await say(ada, adaRoot, adaRoot, room, `line ${i}`);
            assert.equal(r.status, 200, await r.text());
            await wait(5); // distinct said_ms, so a page's edge is a clean cut
        }
        await pullAndFold(HOST_B, adaRoot);
    });

    it("the creator's node keeps the room whole; a reader's node keeps the budget, yet reads the whole room through the archive", async () => {
        let entered = null;
        for (let i = 0; i < 30 && !entered; i++) {
            const r = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`);
            if (r.status === 200) entered = await r.json();
            else await wait(400);
        }
        assert.ok(entered, "bea is in the long room");
        assert.equal(entered.archivist, false, "bea's node is not the archive");
        assert.equal(entered.archived, false, "and nobody pressed full-sync");
        const whole = await readAfterSync(HOST_B, bea, beaRoot, [`line ${LINES}`, "line 1"]);
        assert.deepEqual(
            wordsOf(whole),
            Array.from({ length: LINES }, (_, i) => `line ${LINES - i}`),
            `every line, newest first, on bea's floor: ${JSON.stringify(wordsOf(whole))}`
        );
        assert.equal(!!whole.more, false, "nothing lies beneath line 1");
        assert.equal(await held(HOST), LINES, "the creator's node holds every line");
        assert.equal(await held(HOST_B), BUDGET, "bea's node holds the budget and no more");
    });

    it("scroll-back pages beneath the budget: the page this node keeps, then the archive's", async () => {
        const top = await history(bea, beaRoot, adaRoot, room, `?limit=${BUDGET}`);
        assert.equal(top.items.length, BUDGET, "the first page is what the node keeps");
        assert.equal(top.more, true, "and more lies beneath it");
        assert.equal(top.items[0].words, `line ${LINES}`);
        const oldest = Math.min(...top.items.map((m) => m.said_ms));
        const beneath = await history(bea, beaRoot, adaRoot, room, `?limit=${BUDGET}&before_ms=${oldest}`);
        assert.deepEqual(wordsOf(beneath), ["line 4", "line 3", "line 2", "line 1"], `the archive's page: ${JSON.stringify(wordsOf(beneath))}`);
        assert.equal(!!beneath.more, false, "the room's beginning");
        assert.ok(beneath.items.every((m) => m.speaker === adaRoot), "attributed to ada, whose tree bea's node holds");
        assert.equal(await held(HOST_B), BUDGET, "served, not kept: the budget stands");
    });

    it("full-sync is the operator's button: refused to a plain user, it walks the whole room down and keeps it; released, the budget returns", async () => {
        const refused = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/archive`, { method: "POST" });
        assert.equal(refused.status, 403, "a plain user cannot make the node keep a room whole");
        await sql(`INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${esc(bea.account.id)}', 'node_admin')`, HOST_B);
        const pressed = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/archive`, { method: "POST" });
        const pressedText = await pressed.text();
        assert.equal(pressed.status, 200, pressedText);
        const outcome = JSON.parse(pressedText);
        assert.equal(outcome.archived, true);
        assert.ok(outcome.pulled >= LINES - BUDGET, `the pull walked the chain down: ${JSON.stringify(outcome)}`);
        assert.equal(await held(HOST_B), LINES, "bea's node now holds every line");
        const entered = await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`)).json();
        assert.equal(entered.archived, true, "the room wears its mark");
        assert.equal(entered.archivist, true, "bea's node is an archive now");
        // The floor reads the whole room from what the node keeps - one page, nothing asked.
        const whole = await history(bea, beaRoot, adaRoot, room, `?limit=${LINES}`);
        assert.equal(whole.items.length, LINES);
        // More talk lands and stays: an archived room is never pruned.
        const r = await say(ada, adaRoot, adaRoot, room, `line ${LINES + 1}`);
        assert.equal(r.status, 200, await r.text());
        await readAfterSync(HOST_B, bea, beaRoot, [`line ${LINES + 1}`]);
        assert.equal(await held(HOST_B), LINES + 1, "kept whole as the room grows");
        // Released: the budget applies again at the next fold.
        const released = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/archive`, { method: "DELETE" });
        assert.equal(released.status, 200, await released.text());
        await beat(HOST_B, "fold", adaRoot);
        assert.equal(await held(HOST_B), BUDGET, "the budget stands again");
        const after = await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`)).json();
        assert.equal(after.archived, false);
        assert.equal(after.archivist, false);
    });
});
