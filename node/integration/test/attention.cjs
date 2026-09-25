/*
    Attention (2026-09-25): whenever a badge lights, the desktop app hears about it - through
    the node's attention watcher (node/src/attention.rs), read back here from its local-test
    recorder at /test/attention, which is exactly what the desktop shell would have shown.

    The properties, each one the badge's own rule restated as an alert:
      * a line somebody else says in a room I'm in alerts me, with the room and the words;
        my own line never does;
      * a line I have SEEN never alerts, however it arrives - and the next unseen one still does;
      * a row that lights my bell alerts me, in the bell's words, pointing at the bell.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, makeFetch } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("attention: every badge that lights, said out loud", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, kitchen;

    const alertsFor = async (root) => (await (await makeFetch(HOST)(`test/attention?root=${root}`)).json()) || [];
    const say = (who, root, words) => j(who, `api/identity/${root}/rooms/${adaRoot}/${kitchen}/messages`, { words });
    const history = async () => (await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${kitchen}/messages`)).json()).items || [];
    // Ada's node: sync the room and fold bea's chain until the line is held.
    const heldOnAda = async (words) => {
        for (let i = 0; i < 30; i++) {
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${kitchen}/sync`, { method: "POST" });
            await beat(HOST, "fold", beaRoot);
            if ((await history()).some((m) => m.words === words)) return true;
            await wait(400);
        }
        return false;
    };
    // The watcher wakes on a nudge or a guarded one-second tick: bounded polling, every round
    // a real read of what the desktop would have been told.
    const alertWith = async (pred) => {
        for (let i = 0; i < 30; i++) {
            const found = (await alertsFor(adaRoot)).find(pred);
            if (found) return found;
            await wait(300);
        }
        return null;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "attnada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "attnbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, { value: "high" }, "PUT");
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/interest`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        await pullAndFold(HOST, beaRoot);

        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "the kitchen", body: "bread talk", format: "marquee" })).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, { room: true });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        kitchen = JSON.parse(text).post_id;
        await pullAndFold(HOST_B, adaRoot);
        let entered = false;
        for (let i = 0; i < 30 && !entered; i++) {
            entered = (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${kitchen}`)).status === 200;
            if (!entered) await wait(400);
        }
        assert.ok(entered, "bea is in the kitchen");
    });

    it("a line somebody else says alerts me with the room and the words; my own never does", async () => {
        assert.equal((await say(bea, beaRoot, "is the oven on")).status, 200);
        assert.ok(await heldOnAda("is the oven on"), "ada's node holds bea's line");
        const alert = await alertWith((a) => a.body === "is the oven on");
        assert.ok(alert, `the line alerted ada: ${JSON.stringify(await alertsFor(adaRoot))}`);
        assert.match(alert.title, /the kitchen/, "the alert names the room");
        assert.equal(alert.route, `/home/chat/${adaRoot}/${kitchen}`, "and points into it");

        assert.equal((await say(ada, adaRoot, "it is now")).status, 200);
        await beat(HOST, "fold", adaRoot);
        await wait(1500); // two guarded ticks: the watcher has looked
        assert.ok(!(await alertsFor(adaRoot)).some((a) => a.body === "it is now"), "ada's own line never alerts ada");
    });

    it("a line I have seen never alerts, and the next unseen one still does", async () => {
        // Ada looks at the room: the room view's own write, the rooms_seen register.
        const latest = Math.max(...(await history()).map((m) => m.said_ms));
        const put = await j(ada, `api/identity/${adaRoot}/private/kv/rooms_seen/${adaRoot}:${kitchen}`, { value: String(latest) }, "PUT");
        assert.ok(put.status < 300, await put.text());
        const before = (await alertsFor(adaRoot)).length;

        assert.equal((await say(bea, beaRoot, "bread's done")).status, 200);
        assert.ok(await heldOnAda("bread's done"), "ada's node holds the next line");
        const alert = await alertWith((a) => a.body === "bread's done");
        assert.ok(alert, "the next unseen line alerted");
        const after = await alertsFor(adaRoot);
        assert.equal(
            after.filter((a) => a.body === "is the oven on").length,
            1,
            "the seen line was announced once, when it was news, and never again"
        );
        assert.equal(after.length, before + 1, "exactly one new alert for exactly one new line");
    });

    it("a row that lights my bell alerts me in the bell's words", async () => {
        // Bea replies to one of ada's posts: a comment, the bell's first-class kind.
        const own = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "sourdough notes", body: "day one", format: "plaintext" })).json();
        const ownPub = await j(ada, `api/identity/${adaRoot}/docs/${own.doc_id}/publish`, {});
        const post = JSON.parse(await ownPub.text()).post_id;
        await pullAndFold(HOST_B, adaRoot);
        const r = await (await j(bea, `api/identity/${beaRoot}/docs`, { title: "", body: "looks great", format: "plaintext" })).json();
        const reply = await j(bea, `api/identity/${beaRoot}/docs/${r.doc_id}/publish`, { reply_to: { author: adaRoot, doc_id: post } });
        assert.equal(reply.status, 200, await reply.text());

        // The premise: ada's bell lights for it.
        let lit = null;
        for (let i = 0; i < 30 && !lit; i++) {
            await pullAndFold(HOST, beaRoot);
            const bell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
            lit = (bell.items || []).find((x) => !x.seen && x.author === beaRoot && x.kind === "comment");
            if (!lit) await wait(400);
        }
        assert.ok(lit, "ada's bell lit for bea's reply");

        const alert = await alertWith((a) => a.route === "/home/notifications" && /replied/.test(a.body));
        assert.ok(alert, `the bell's row alerted: ${JSON.stringify(await alertsFor(adaRoot))}`);
        assert.match(alert.body, /sourdough notes/, "naming the post, as the bell's card does");
    });
});
