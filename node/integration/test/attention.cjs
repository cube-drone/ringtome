/*
    Attention (2026-09-25): whenever a badge lights, the desktop app hears about it - through
    the node's attention watcher (node/src/attention.rs), read back here from its local-test
    recorder at /test/attention, which is exactly what the desktop shell would have shown.

    The properties, each one the badge's own rule restated as an alert:
      * a line somebody else says in a room I'm in alerts me, with the room and the words;
        my own line never does;
      * a line I have SEEN never alerts, however it arrives - and the next unseen one still does;
      * a row that lights my bell alerts me, in the bell's words, pointing at the bell;
      * and a browser that asked for Web Push hears the same alert with no tab open: this file
        plays the browser AND its vendor's push service - an http server on loopback that
        receives each push, decrypts it with its own key per RFC 8291 using Node's crypto (an
        implementation independent of the node's), verifies the VAPID signature against the key
        the request carries, and answers 410 once to prove a dead subscription is let go.
*/
const assert = require("node:assert");
const crypto = require("node:crypto");
const http = require("node:http");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, makeFetch, sql } = require("./fetch.cjs");

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

    /// The receiving half of RFC 8291, independently: what a browser does with a push.
    const decryptPush = (body, ua, auth) => {
        const salt = body.subarray(0, 16);
        const idlen = body[20];
        const asPublic = body.subarray(21, 21 + idlen);
        const sealed = body.subarray(21 + idlen);
        const shared = ua.computeSecret(asPublic);
        const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
        const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, keyInfo, 32));
        const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
        const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
        const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
        let end = record.length - 1;
        while (end >= 0 && record[end] === 0) end--; // padding
        assert.equal(record[end], 2, "the last record ends in the 0x02 delimiter");
        return JSON.parse(record.subarray(0, end).toString("utf8"));
    };

    /// RFC 8292: the token verifies against the key the header carries, for this origin.
    const verifyVapid = (header, audience) => {
        const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || "");
        assert.ok(m, `a VAPID authorization header: ${header}`);
        const [, token, k] = m;
        const [h, c, sig] = token.split(".");
        const raw = Buffer.from(k, "base64url");
        const key = crypto.createPublicKey({
            key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") },
            format: "jwk",
        });
        const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"));
        assert.ok(ok, "the VAPID signature verifies against its own key");
        const claims = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
        assert.equal(claims.aud, audience, "the audience is the push service's origin");
        assert.ok(claims.exp > Date.now() / 1000, "and it has not expired");
        assert.match(claims.sub, /^https:|^mailto:/, "and it says who is pushing");
        return k;
    };

    it("Web Push: a subscribed browser hears the alert, encrypted to it and signed by the node", async () => {
        // The fake push service: records every push, answers as told.
        const pushes = [];
        let answer = 201;
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
                res.writeHead(answer);
                res.end();
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const origin = `http://127.0.0.1:${server.address().port}`;
        try {
            // The browser: its own keypair and secret, as PushManager.subscribe() would mint.
            const ua = crypto.createECDH("prime256v1");
            ua.generateKeys();
            const auth = crypto.randomBytes(16);
            const key = await (await ada(`api/identity/${adaRoot}/push`)).json();
            assert.equal(Buffer.from(key.public_key, "base64url").length, 65, "the node's key is an uncompressed P-256 point");

            // A subscription the node cannot use is refused at the door.
            const bad = await j(ada, `api/identity/${adaRoot}/push`, { endpoint: "not a url", keys: { p256dh: "x", auth: "y" } });
            assert.equal(bad.status, 400, await bad.text());

            const sub = await j(ada, `api/identity/${adaRoot}/push`, {
                endpoint: `${origin}/push/ada-browser`,
                keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
            });
            assert.equal(sub.status, 200, await sub.text());

            assert.equal((await say(bea, beaRoot, "anyone for toast")).status, 200);
            assert.ok(await heldOnAda("anyone for toast"), "ada's node holds bea's line");
            let got = null;
            for (let i = 0; i < 40 && !got; i++) {
                got = pushes.find((p) => p.path === "/push/ada-browser");
                if (!got) await wait(250);
            }
            assert.ok(got, "the node pushed to the browser's endpoint");
            assert.equal(got.headers["content-encoding"], "aes128gcm");
            assert.ok(Number(got.headers.ttl) > 0, "with a TTL");
            const signedWith = verifyVapid(got.headers.authorization, origin);
            assert.equal(signedWith, key.public_key, "signed by the key the browser subscribed against");
            const alert = decryptPush(got.body, ua, auth);
            assert.equal(alert.body, "anyone for toast", "the browser reads the words");
            assert.match(alert.title, /the kitchen/);
            assert.equal(alert.route, `/home/chat/${adaRoot}/${kitchen}`, "and knows where the click lands");

            // The browser let go (410): the next push forgets the subscription.
            answer = 410;
            const before = pushes.length;
            assert.equal((await say(bea, beaRoot, "last call for toast")).status, 200);
            assert.ok(await heldOnAda("last call for toast"));
            for (let i = 0; i < 40 && pushes.length === before; i++) await wait(250);
            assert.ok(pushes.length > before, "the next alert was pushed, and refused");
            let rows = [1];
            for (let i = 0; i < 20 && rows.length; i++) {
                rows = (await sql(`SELECT 1 AS n FROM push_subscriptions WHERE root_pubkey = '${adaRoot}'`, HOST)).rows;
                if (rows.length) await wait(250);
            }
            assert.equal(rows.length, 0, "a 410 deletes the subscription");
        } finally {
            server.close();
        }
    });
});
