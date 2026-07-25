/*
    The live cache stream (PROJECT_PLAN, The Browser Is a View - Stage 1): a read-only
    WebSocket per persona, streaming the same view rows the HTTP reads serve.

    The load-bearing behaviors: no cursor → full snapshot; a write lands as an update within
    seconds (the echo that will someday clear shadows); a matching cursor skips the snapshot
    ("live"); a doubtful cursor gets the snapshot (the mirror is disposable); client messages
    are ignored, never honored (read-only by doctrine); strangers get no socket at all; and -
    the point of the whole design - a write on ANOTHER NODE arrives down this node's stream
    with nobody polling anything.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
const WebSocket = require("ws");

const { HOST, HOST_B } = require("./fetch.cjs");
const { uniqueUsername } = require("./helpers.cjs");

const PW = "test-password-123";

// Raw fetch with an explicit Cookie header - the ws upgrade needs the cookie string itself,
// so this file manages its session by hand instead of through makeUserFetch's hidden jar.
async function rawLogin(host) {
    const username = uniqueUsername("lc");
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
    return { username, cookie, authed };
}

// A websocket with promise-shaped reads: `await next()` yields the next JSON frame.
function openStream(host, root, cookie, cursor) {
    const url = `ws://${host}/api/identity/${root}/stream${
        cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
    }`;
    const ws = new WebSocket(url, { headers: { Cookie: cookie } });
    const queue = [];
    const waiters = [];
    ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        const w = waiters.shift();
        if (w) w.resolve(msg);
        else queue.push(msg);
    });
    const opened = new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        ws.on("unexpected-response", (_req, res) =>
            reject(new Error(`upgrade refused: ${res.statusCode}`))
        );
    });
    const next = (timeoutMs = 10000) =>
        new Promise((resolve, reject) => {
            const q = queue.shift();
            if (q) return resolve(q);
            const timer = setTimeout(
                () => reject(new Error(`no frame within ${timeoutMs}ms`)),
                timeoutMs
            );
            waiters.push({
                resolve: (m) => {
                    clearTimeout(timer);
                    resolve(m);
                },
            });
        });
    return { ws, opened, next };
}

const profileName = (msg) => (msg.profile.find((f) => f.field === "name") || {}).value;

describe("the live cache stream", function () {
    this.timeout(30000);

    it("snapshots on first contact, then echoes writes as updates", async function () {
        const { cookie, authed } = await rawLogin(HOST);
        const created = await (await authed("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        await authed(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "First" }),
        });

        const stream = openStream(HOST, root, cookie);
        await stream.opened;
        const snapshot = await stream.next();
        assert.equal(snapshot.type, "snapshot");
        assert.ok(snapshot.cursor.match(/^[0-9a-f]{64}$/), "cursor is an opaque token");
        assert.equal(profileName(snapshot), "First");
        assert.deepEqual(snapshot.docs, [], "no documents yet");
        assert.deepEqual(snapshot.taxonomies, []);

        // A write echoes down the stream - the mechanism that will clear shadows someday.
        await authed(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Second" }),
        });
        const update = await stream.next();
        assert.equal(update.type, "update");
        assert.equal(profileName(update), "Second");
        assert.notEqual(update.cursor, snapshot.cursor, "the cursor moved with the frontier");

        // Documents ride the same stream: create one, watch it arrive.
        await authed(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({ title: "first note", body: "hello mirror" }),
        });
        const docUpdate = await stream.next();
        assert.equal(docUpdate.docs.length, 1);
        assert.equal(docUpdate.docs[0].title, "first note");

        // The search index rides the same stream: a token-bag row over title + body.
        assert.equal(docUpdate.search.length, 1, "one search row");
        assert.equal(docUpdate.search[0].doc_id, docUpdate.docs[0].doc_id);
        const tokens = docUpdate.search[0].tokens.split(" ");
        for (const w of ["first", "note", "hello", "mirror"]) {
            assert.ok(tokens.includes(w), `search tokens include "${w}": ${tokens}`);
        }

        // Reconnect with the fresh cursor: nothing missed, no snapshot - just "live".
        stream.ws.close();
        const resumed = openStream(HOST, root, cookie, docUpdate.cursor);
        await resumed.opened;
        const first = await resumed.next();
        assert.equal(first.type, "live", "a matching cursor skips the snapshot");
        assert.equal(first.cursor, docUpdate.cursor);
        resumed.ws.close();

        // A doubtful cursor gets the full snapshot: the mirror is disposable by design.
        const doubtful = openStream(HOST, root, cookie, "not-a-cursor");
        await doubtful.opened;
        const again = await doubtful.next();
        assert.equal(again.type, "snapshot");
        assert.equal(again.docs.length, 1);
        doubtful.ws.close();
    });

    it("the socket is read-only: client chatter is ignored, never honored", async function () {
        const { cookie, authed } = await rawLogin(HOST);
        const created = await (await authed("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const stream = openStream(HOST, root, cookie);
        await stream.opened;
        await stream.next(); // snapshot

        // Shout into the read-only socket, then prove it neither acted nor died.
        stream.ws.send(JSON.stringify({ type: "set", field: "name", value: "EVIL" }));
        await authed(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Still Mine" }),
        });
        const update = await stream.next();
        assert.equal(profileName(update), "Still Mine", "the POST landed, the chatter did not");
        stream.ws.close();
    });

    it("strangers get no socket at all", async function () {
        const { cookie, authed } = await rawLogin(HOST);
        const created = await (await authed("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // No cookie: refused at upgrade, before any socket exists. (`terminate()` after the
        // refusal matters: a ws client that got `unexpected-response` keeps its socket - and
        // the whole test process - alive unless destroyed. This exact leak once wedged the
        // suite at exit while every node stayed healthy.)
        const anon = openStream(HOST, root, "");
        await assert.rejects(anon.opened, /upgrade refused: 401/);
        anon.ws.terminate();

        // Someone else's cookie: same, with the uniform 404 (no confirming what exists).
        const mallory = await rawLogin(HOST);
        const wrong = openStream(HOST, root, mallory.cookie);
        await assert.rejects(wrong.opened, /upgrade refused: 404/);
        wrong.ws.terminate();
    });
});

(HOST_B ? describe : describe.skip)("the live cache across nodes", function () {
    this.timeout(60000);

    it("a write on another computer arrives down this node's stream", async function () {
        // Persona on A, adopted to B (in one trip), stream open on A.
        const a = await rawLogin(HOST);
        const created = await (await a.authed("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const b = await rawLogin(HOST_B);
        const request = await (
            await b.authed("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const grant = await (
            await a.authed(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        assert.equal(grant.delivered, true);

        const stream = openStream(HOST, root, a.cookie);
        await stream.opened;
        await stream.next(); // snapshot

        // Write on B. Eager push carries it to A; A's fold surfaces it; the stream sends it.
        // Nobody on this socket asked for anything.
        await b.authed(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Written On B" }),
        });
        let name = null;
        const deadline = Date.now() + 30000;
        while (!name && Date.now() < deadline) {
            const msg = await stream.next(30000);
            const value = profileName(msg);
            if (value === "Written On B") name = value;
        }
        assert.equal(name, "Written On B", "the other computer's write flowed down the stream");
        stream.ws.close();
    });
});
