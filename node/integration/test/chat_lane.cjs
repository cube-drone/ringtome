/*
    The room lane (CHAT.md, slice 2, 2026-09-18): messages are entries on each speaker's own
    chain, on the room's instance, and they arrive by sync alone. Ada opens a room; bea,
    following and trusted, enters and speaks, and her chain reaches ada's node - the
    directory of record - by push; ada answers, and the room's history interleaves both. Cal,
    a stranger by link, pulls the room from ada's node and reads both, then speaks, and his
    words reach ada. A sealed room's words travel as ciphertext: bea reads them, cal cannot
    even enter. Closing the room (ruling 10) refuses the next message and stands the record.
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

(HOST_B && HOST_C ? describe : describe.skip)("the room lane: messages travel by chain", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, kitchen, cellar, kitchenDraft;

    const openRoom = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        await who(`api/identity/${root}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, { room: true, ...extra });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return { post: JSON.parse(text).post_id, draft: d.doc_id };
    };
    const enter = async (who, root, author, doc) => who(`api/identity/${root}/rooms/${author}/${doc}`);
    const say = async (who, root, author, doc, words) => j(who, `api/identity/${root}/rooms/${author}/${doc}/messages`, { words });
    const history = async (who, root, author, doc) => (await (await who(`api/identity/${root}/rooms/${author}/${doc}/messages`)).json());
    const wordsOf = (h) => (h.items || []).map((m) => m.words);
    // The reader's node pulls the room, folds each speaker's chain, then reads.
    const readAfterSync = async (host, who, root, author, doc, want, tries = 30) => {
        let h = { items: [] };
        for (let i = 0; i < tries; i++) {
            await who(`api/identity/${root}/rooms/${author}/${doc}/sync`, { method: "POST" });
            for (const speaker of new Set([author, ...(h.items || []).map((m) => m.speaker), adaRoot, beaRoot, calRoot].filter(Boolean))) {
                await beat(host, "fold", speaker);
            }
            h = await history(who, root, author, doc);
            if (want.every((w) => wordsOf(h).includes(w))) return h;
            await wait(400);
        }
        return h;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "laneada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "lanebea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "lanecal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        await pullAndFold(HOST, beaRoot);
        ({ post: kitchen, draft: kitchenDraft } = await openRoom(ada, adaRoot, "the kitchen", "where the bread talk happens"));
        ({ post: cellar } = await openRoom(ada, adaRoot, "the cellar", "the quiet one", { trusted_only: true }));
        await pullAndFold(HOST_B, adaRoot);
    });

    it("a follower speaks, and her chain reaches the creator's node; the creator answers", async () => {
        let entered = null;
        for (let i = 0; i < 30 && !entered; i++) {
            const r = await enter(bea, beaRoot, adaRoot, kitchen);
            if (r.status === 200) entered = await r.json();
            else await wait(400);
        }
        assert.ok(entered, "bea is in the kitchen");
        const said = await say(bea, beaRoot, adaRoot, kitchen, "hello from bea");
        assert.equal(said.status, 200, await said.text());
        // Her own node shows it at once, off her own chain.
        let mine = { items: [] };
        for (let i = 0; i < 20 && !wordsOf(mine).includes("hello from bea"); i++) {
            await beat(HOST_B, "fold", beaRoot);
            mine = await history(bea, beaRoot, adaRoot, kitchen);
            if (!wordsOf(mine).includes("hello from bea")) await wait(300);
        }
        assert.ok(wordsOf(mine).includes("hello from bea"), "the speaker's own floor shows her words");
        // The creator's node: the push landed her chain; the fold folds it.
        const theirs = await readAfterSync(HOST, ada, adaRoot, adaRoot, kitchen, ["hello from bea"]);
        assert.ok(wordsOf(theirs).includes("hello from bea"), `ada's node holds bea's words: ${JSON.stringify(theirs)}`);
        const answer = await say(ada, adaRoot, adaRoot, kitchen, "welcome, bea");
        assert.equal(answer.status, 200, await answer.text());
        const both = await readAfterSync(HOST, ada, adaRoot, adaRoot, kitchen, ["hello from bea", "welcome, bea"]);
        assert.deepEqual(wordsOf(both), ["welcome, bea", "hello from bea"], "newest first, both speakers interleaved");
        assert.equal(both.items[0].speaker, adaRoot);
        assert.equal(both.items[1].speaker, beaRoot);
    });

    it("a stranger by link pulls the room from the creator's node, reads both, and is heard back", async function () {
        const seen = await cal(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
        if (seen.status !== 200) this.skip();
        let open = null;
        for (let i = 0; i < 30 && !open; i++) {
            const r = await enter(cal, calRoot, adaRoot, kitchen);
            if (r.status === 200) open = await r.json();
            else await wait(400);
        }
        assert.ok(open, "cal is in the kitchen");
        const his = await readAfterSync(HOST_C, cal, calRoot, adaRoot, kitchen, ["hello from bea", "welcome, bea"]);
        assert.ok(wordsOf(his).includes("hello from bea") && wordsOf(his).includes("welcome, bea"), `cal reads both: ${JSON.stringify(his)}`);
        const said = await say(cal, calRoot, adaRoot, kitchen, "hi all, cal here");
        assert.equal(said.status, 200, await said.text());
        const heard = await readAfterSync(HOST, ada, adaRoot, adaRoot, kitchen, ["hi all, cal here"]);
        assert.ok(wordsOf(heard).includes("hi all, cal here"), "the creator's node heard the stranger");
        // And bea, pulling the room again, hears cal through ada's node.
        const beaHears = await readAfterSync(HOST_B, bea, beaRoot, adaRoot, kitchen, ["hi all, cal here", "welcome, bea"]);
        assert.ok(wordsOf(beaHears).includes("hi all, cal here"), "bea hears cal through the creator's node");
    });

    it("a sealed room's words travel as ciphertext: the trusted reader opens them, the stranger cannot enter", async () => {
        let entered = null;
        for (let i = 0; i < 30 && !entered; i++) {
            const r = await enter(bea, beaRoot, adaRoot, cellar);
            if (r.status === 200) entered = await r.json();
            else await wait(400);
        }
        assert.ok(entered, "bea is in the cellar");
        const said = await say(bea, beaRoot, adaRoot, cellar, "the secret recipe");
        assert.equal(said.status, 200, await said.text());
        const theirs = await readAfterSync(HOST, ada, adaRoot, adaRoot, cellar, ["the secret recipe"]);
        assert.ok(wordsOf(theirs).includes("the secret recipe"), "ada opens bea's sealed words with the room's key");
        const refused = await enter(cal, calRoot, adaRoot, cellar);
        assert.equal(refused.status, 403);
        const noSync = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${cellar}/sync`, { method: "POST" });
        assert.equal(noSync.status, 403, "nor may his node pull it");
    });

    it("closing the room (ruling 10) refuses the next message and stands the record", async () => {
        const closed = await j(ada, `api/identity/${adaRoot}/docs/${kitchenDraft}/publish`, { settled: true });
        assert.equal(closed.status, 200, await closed.text());
        const head = await (await ada(`api/id/${adaRoot}/posts/${kitchen}`)).json();
        assert.equal(head.settled, true, "the room post wears the settled wish");
        assert.equal(head.format, "room", "and is still a room");
        const late = await say(ada, adaRoot, adaRoot, kitchen, "one more thing");
        const words = await late.text();
        assert.equal(late.status, 400, words);
        assert.match(words, /closed/);
        const record = await history(ada, adaRoot, adaRoot, kitchen);
        assert.equal(record.closed, true);
        assert.ok(wordsOf(record).includes("hello from bea") && wordsOf(record).includes("welcome, bea"), "the record stands");
    });
});
