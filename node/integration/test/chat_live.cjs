/*
    Live (CHAT.md, slice 3, 2026-09-18): a room's topic on iroh-gossip carries the same signed
    entries the chains carry. Ada opens a room and her node joins its topic when she opens the
    room's socket; bea, following and trusted, enters and opens hers. Bea says something and
    it reaches ada's floor with no beat rung - by gossip, verified and folded through the gate
    sync uses - and ada's socket says the floor moved. Presence and typing ride the same
    topic: ada's socket hears that bea is here, and that she is typing.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
const WebSocket = require("ws");

const { uniqueUsername } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B } = require("./fetch.cjs");

const PW = "test-password-123";

// A session by hand (livecache.cjs's idiom): the socket upgrade needs the cookie itself.
async function rawLogin(host, prefix) {
    const username = uniqueUsername(prefix);
    await fetch(`http://${host}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: PW }),
    });
    const res = await fetch(`http://${host}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: PW }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie").split(";")[0];
    const authed = (path, opts = {}) =>
        fetch(`http://${host}/${path}`, {
            ...opts,
            headers: {
                Cookie: cookie,
                ...(opts.body ? { "Content-Type": "application/json" } : {}),
            },
        });
    authed.cookie = cookie;
    return authed;
}

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// A room socket with promise-shaped reads (livecache.cjs's idiom).
function openLive(host, cookie, root, author, doc) {
    const ws = new WebSocket(`ws://${host}/api/identity/${root}/rooms/${author}/${doc}/live`, { headers: { Cookie: cookie } });
    const frames = [];
    const waiters = [];
    ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        frames.push(msg);
        for (const w of waiters.splice(0)) w();
    });
    const opened = new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        ws.on("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    });
    // Wait until some frame satisfies `pred`, or give up.
    const until = (pred, timeoutMs = 20000) =>
        new Promise((resolve, reject) => {
            const check = () => frames.some(pred);
            if (check()) return resolve(true);
            const timer = setTimeout(() => reject(new Error(`no matching frame within ${timeoutMs}ms: ${JSON.stringify(frames.slice(-5))}`)), timeoutMs);
            const w = () => {
                if (check()) {
                    clearTimeout(timer);
                    resolve(true);
                } else {
                    waiters.push(w); // not yet: watch the next frame too
                }
            };
            waiters.push(w);
        });
    return { ws, opened, until, frames, send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() };
}

(HOST_B ? describe : describe.skip)("live: a room's topic carries the chains", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, kitchen, adaLive, beaLive;

    before(async function () {
        ada = await rawLogin(HOST, "liveada");
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await rawLogin(HOST_B, "livebea");
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        await pullAndFold(HOST, beaRoot);
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "the kitchen", body: "live now", format: "marquee" })).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, { room: true });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        kitchen = JSON.parse(text).post_id;
        await pullAndFold(HOST_B, adaRoot);
        // Both enter. Bea's node pulls the room from ada's on entering, which is also how
        // its endpoint learns the path the topic's join will need.
        assert.equal((await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${kitchen}`)).status, 200);
        let entered = false;
        for (let i = 0; i < 30 && !entered; i++) {
            entered = (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${kitchen}`)).status === 200;
            if (!entered) await wait(400);
        }
        assert.ok(entered, "bea is in the kitchen");
        await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${kitchen}/sync`, { method: "POST" });
    });

    after(() => {
        if (adaLive) adaLive.close();
        if (beaLive) beaLive.close();
    });

    it("both sockets open, and each hears the other arrive", async () => {
        adaLive = openLive(HOST, ada.cookie, adaRoot, adaRoot, kitchen);
        await adaLive.opened;
        beaLive = openLive(HOST_B, bea.cookie, beaRoot, adaRoot, kitchen);
        await beaLive.opened;
        await adaLive.until((f) => f.type === "presence" && (f.here || []).includes(beaRoot), 30000);
        await beaLive.until((f) => f.type === "presence" && (f.here || []).includes(adaRoot), 30000);
    });

    it("a message crosses by gossip: no beat, the floor moves, the socket says so", async () => {
        const before = adaLive.frames.filter((f) => f.type === "message").length;
        const said = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${kitchen}/messages`, { words: "hello, live" });
        assert.equal(said.status, 200, await said.text());
        await adaLive.until((f) => f.type === "message", 20000);
        assert.ok(adaLive.frames.filter((f) => f.type === "message").length > before, "ada's socket said the floor moved");
        let words = [];
        for (let i = 0; i < 40 && !words.includes("hello, live"); i++) {
            const h = await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${kitchen}/messages`)).json();
            words = (h.items || []).map((m) => m.words);
            if (!words.includes("hello, live")) await wait(250);
        }
        assert.ok(words.includes("hello, live"), `bea's words landed on ada's floor by the live lane: ${words}`);
        // And the other way.
        const answer = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${kitchen}/messages`, { words: "hearing you" });
        assert.equal(answer.status, 200, await answer.text());
        let heard = [];
        for (let i = 0; i < 40 && !heard.includes("hearing you"); i++) {
            const h = await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${kitchen}/messages`)).json();
            heard = (h.items || []).map((m) => m.words);
            if (!heard.includes("hearing you")) await wait(250);
        }
        assert.ok(heard.includes("hearing you"), `ada's words landed on bea's floor: ${heard}`);
    });

    it("typing is a beacon on the same topic", async () => {
        beaLive.send({ typing: true });
        await adaLive.until((f) => f.type === "presence" && (f.typing || []).includes(beaRoot), 20000);
        beaLive.send({ typing: false });
        await adaLive.until((f) => f.type === "presence" && !(f.typing || []).includes(beaRoot) && (f.here || []).includes(beaRoot), 20000);
    });
});
