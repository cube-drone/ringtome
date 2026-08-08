/*
    The node's subscription memo (net::subscriptions): who each hosted persona follows, and whom
    they PUBLICLY trust, derived from their own contact ledger.

    The line this table walks is the point of most of these assertions. Routing facts (interest,
    rebroadcast) belong at node level by doctrine - "the node routes; the user ranks". A trust
    value is here only where its author set `trust_public`, because a private assessment must not
    have publicly measurable effects: acting on a quiet edge would let a stranger detect it by
    measuring how well this node treats them.
*/
const assert = require("node:assert");
const { sql } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = async (fn, tries = 60) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

let owner, root;
const THEM = "ab".repeat(32);

const rowsFor = async (local) => {
    const { rows } = await sql(
        `SELECT foreign_root, eagerness, rebroadcast, trust FROM subscriptions
         WHERE local_root = '${local}' ORDER BY foreign_root`
    );
    return rows;
};

const dial = (key, value) =>
    owner(`api/identity/${root}/private/kv/contact:${THEM}/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value: String(value) }),
    });

before(async () => {
    owner = await makeUserFetch({ prefix: "subs" });
    const made = await (await owner("api/identity", { method: "POST" })).json();
    root = made.root_pubkey;
});

describe("the subscription memo", () => {
    it("records a follow as routing, without being asked", async () => {
        const r = await dial("interest", 75);
        assert.equal(r.status, 200, await r.text());
        const rows = await settle(async () => {
            const got = await rowsFor(root);
            return got.length ? got : null;
        });
        assert.ok(rows, "the sweep found the new edge on its own");
        assert.equal(rows[0].foreign_root, THEM);
        assert.equal(rows[0].eagerness, 75, "the interest dial IS the sync-cadence dial");
        assert.equal(rows[0].trust, null);
    });

    it("carries rebroadcast interest alongside it", async () => {
        await dial("interest_rebroadcasts", 25);
        const rows = await settle(async () => {
            const got = await rowsFor(root);
            return got[0] && got[0].rebroadcast === 25 ? got : null;
        });
        assert.ok(rows, "the second routing dial lands too");
        assert.equal(rows[0].eagerness, 75, "and the first one is still there");
    });

    it("WITHHOLDS a quiet trust edge - the whole reason trust is allowed here at all", async () => {
        await dial("trust", 95);
        await new Promise((r) => setTimeout(r, 3000));
        const rows = await rowsFor(root);
        assert.equal(
            rows[0].trust,
            null,
            "an unconsented assessment never leaves the persona's own database"
        );
    });

    it("carries it once its author consents", async () => {
        await dial("trust_public", "true");
        const rows = await settle(async () => {
            const got = await rowsFor(root);
            return got[0] && got[0].trust !== null ? got : null;
        });
        assert.ok(rows, "consent is what makes it the node's business");
        assert.equal(rows[0].trust, 95, "the raw value, not a bucket");
    });

    it("withdraws it the moment consent is withdrawn", async () => {
        await dial("trust_public", "false");
        const rows = await settle(async () => {
            const got = await rowsFor(root);
            return got[0] && got[0].trust === null ? got : null;
        });
        assert.ok(rows, "un-consenting takes the value back out");
        assert.equal(rows[0].eagerness, 75, "and leaves the routing facts alone");
    });

    /*
        THEM is a stranger root - nothing of theirs was ever synced here - and following a
        stranger is the ordinary case (you paste an address before any content arrives). The
        follow-backfill path reaches for their shelf, and `user_dbs.get` CREATES on open, so
        it used to write them an empty database, WAL and journal: ~96 KB of files per contact
        this node has never met. A device adopting a big ledger does that for every contact
        at once, since the memo's first refresh sees them all as newly eager.
    */
    it("backfilling a stranger mints no database - exists, not get", async function () {
        const dataDir = process.env.RINGTOME_TEST_DATA_DIR;
        if (!dataDir) this.skip();
        const fs = require("node:fs");
        const dbPath = `${dataDir}/users/${THEM}.db`;

        // The dials above already put THEM on the roster; prove the memo actually ran (so
        // the assertion below can't pass by arriving before the backfill path did).
        const rows = await settle(async () => {
            const got = await rowsFor(root);
            return got.length ? got : null;
        });
        assert.ok(rows, "the memo refresh has run for this contact");
        assert.ok(
            !fs.existsSync(dbPath),
            "a persona we hold nothing of gets no database minted for them"
        );
    });

    it("forgets a contact whose last dial goes back to nothing", async () => {
        // Clearing a register writes an empty value, which parses as no dial at all.
        await dial("interest", "");
        await dial("interest_rebroadcasts", "");
        await dial("trust", "");
        const gone = await settle(async () => {
            const got = await rowsFor(root);
            return got.length === 0 ? true : null;
        });
        assert.ok(gone, "a subscription nobody holds must not keep routing");
    });
});

/*
    The demand record (net::demand): who asked this node about which persona.

    The fan-out address list, and the answer was already crossing the wire unrecorded - a node
    that dials us and names a persona has told us it wants that persona. Asking is telling, so
    there is no consent flag in this story: they initiated the contact.
*/
const { HOST_B, sql: sqlOn } = require("./fetch.cjs");

(HOST_B ? describe : describe.skip)("the demand record", function () {
    this.timeout(60000);

    it("remembers a node that came asking, and does not confuse it for a device", async function () {
        // A persona on node A, with something public to want.
        const mine = await makeUserFetch({ prefix: "demanded" });
        const made = await (await mine("api/identity", { method: "POST" })).json();
        const root = made.root_pubkey;
        const note = await (
            await mine(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Read me", body: "out loud", format: "plaintext" }),
            })
        ).json();
        await mine(`api/identity/${root}/docs/${note.doc_id}/publish`, { method: "POST" });

        const demand = async () => {
            const { rows } = await sqlOn(
                `SELECT endpoint_id, last_asked_ms FROM identity_demand
                 WHERE root_pubkey = '${root}'`
            );
            return rows;
        };
        assert.deepEqual(await demand(), [], "nobody has asked yet");

        // A member of node B looks them up, which dials A and names this persona.
        const { toBase58 } = await import("../../js/speakable.js");
        const endpointA = (await (await mine("api/node")).json()).endpoint_id;
        const stranger = await makeUserFetch({ prefix: "asker", host: HOST_B });
        const resp = await stranger(`api/id/${root}/profile?via=${toBase58(endpointA)}`);
        assert.equal(resp.status, 200, await resp.text());

        const asked = await settle(async () => {
            const rows = await demand();
            return rows.length ? rows : null;
        });
        assert.ok(asked, "A wrote down that somebody came asking about this persona");
        assert.ok(asked[0].last_asked_ms > 0, "with when");
        const endpointB = (await (await stranger("api/node")).json()).endpoint_id;
        assert.equal(asked[0].endpoint_id, endpointB, "and which node it was");

        // The distinction that matters: a reader is NOT a device. identity_peers means "nodes
        // that are this identity" - member-proven, entitled to private chains - and a stranger
        // asking about a public persona must never land there.
        const { rows: peers } = await sqlOn(
            `SELECT endpoint_id FROM identity_peers WHERE root_pubkey = '${root}'`
        );
        assert.ok(
            !peers.some((p) => p.endpoint_id === endpointB),
            "asking about someone does not make you one of their computers"
        );
    });
});

/*
    The byline cache (src/profiles.rs): every persona's public name and avatar, memoized at
    node level so a LIST answers "who is this?" from one table instead of opening one encrypted
    database per face. The contacts join used to do exactly that per stream snapshot; it now
    reads this cache, so these tests pin both halves - the cache tracks the claim, and the
    roster actually serves what the cache holds.
*/
describe("the byline cache", () => {
    let who, whoRoot, watcher, watcherRoot;

    const cacheRow = async (root) => {
        const { rows } = await sql(
            `SELECT name, avatar, updated_at_ms FROM persona_profiles
             WHERE root_pubkey = '${root}'`
        );
        return rows[0] || null;
    };

    before(async () => {
        who = await makeUserFetch({ prefix: "byline" });
        whoRoot = (await (await who("api/identity", { method: "POST" })).json()).root_pubkey;
        watcher = await makeUserFetch({ prefix: "bylinewatch" });
        watcherRoot = (await (await watcher("api/identity", { method: "POST" })).json())
            .root_pubkey;
    });

    it("learns a persona's name from the same edge fan-out rides", async () => {
        await who(`api/identity/${whoRoot}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Cache Me" }),
        });
        const row = await settle(async () => {
            const r = await cacheRow(whoRoot);
            return r && r.name === "Cache Me" ? r : null;
        });
        assert.ok(row, "the rename reached the cache unasked");
    });

    it("follows a rename, and updated_at_ms means the CLAIM moved", async () => {
        const before = await cacheRow(whoRoot);
        await who(`api/identity/${whoRoot}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Cache Me Again" }),
        });
        const after = await settle(async () => {
            const r = await cacheRow(whoRoot);
            return r && r.name === "Cache Me Again" ? r : null;
        });
        assert.ok(after, "the new name landed");
        assert.ok(after.updated_at_ms >= before.updated_at_ms, "and the claim-stamp moved");
    });

    it("the contacts roster serves the cached byline - no database per face", async () => {
        // The watcher records ANY fact about them, which puts them on the roster. The roster
        // rides only the live-cache stream (there is no HTTP contacts endpoint - the mirror is
        // the reader), so read one snapshot the way the browser does.
        await watcher(`api/identity/${watcherRoot}/private/kv/contact:${whoRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "50" }),
        });
        const WebSocket = require("ws");
        const { HOST } = require("./fetch.cjs");
        const cookie = watcher.jar
            ? await watcher.jar.getCookieString(`http://${HOST}/`)
            : null;
        assert.ok(cookie, "the fetch jar exposes its session for the ws upgrade");
        const snapshot = await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://${HOST}/api/identity/${watcherRoot}/stream`, {
                headers: { Cookie: cookie },
            });
            const timer = setTimeout(() => reject(new Error("no snapshot in time")), 10000);
            ws.on("message", (data) => {
                clearTimeout(timer);
                ws.close();
                resolve(JSON.parse(data.toString()));
            });
            ws.on("error", reject);
        });
        const them = (snapshot.contacts || []).find((c) => c.root === whoRoot);
        assert.ok(them, "the roster carries the contact");
        assert.equal(them.name, "Cache Me Again", "wearing the name the cache holds");
    });
});

/*
    The memo hears about a dial turned on ANOTHER device. A contact dial reaches the persona's
    other nodes by sync, and ingest never rings the nudge bus (relay damping) - so this only
    works through the post-ingest hook. The backstop tick is ten MINUTES now precisely so this
    test cannot pass by accident: if the hook goes missing, the settle window expires long
    before the tick would mask it.
*/
(HOST_B ? describe : describe.skip)("the memo, across devices", function () {
    this.timeout(60000);

    it("a dial turned on device A reaches device B's subscriptions memo by sync", async function () {
        const onA = await makeUserFetch({ prefix: "memoa" });
        const made = await (await onA("api/identity", { method: "POST" })).json();
        const shared = made.root_pubkey;

        // The add-a-node ceremony: the persona now lives on A and B.
        const onB = await makeUserFetch({ prefix: "memob", host: HOST_B });
        const request = await (await onB("api/identity/adopt/begin", { method: "POST" })).json();
        const grant = await (
            await onA(`api/identity/${shared}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        const done = await onB("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });
        assert.equal(done.status, 200, await done.text());

        // Turn a dial on A...
        await onA(`api/identity/${shared}/private/kv/contact:${THEM}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "75" }),
        });

        // ...and B's node-level memo must learn it from the exchange itself.
        const onBMemo = await settle(async () => {
            const { rows } = await sqlOn(
                `SELECT eagerness FROM subscriptions
                 WHERE local_root = '${shared}' AND foreign_root = '${THEM}'`,
                HOST_B
            );
            return rows.length && rows[0].eagerness === 75 ? rows : null;
        }, 80);
        assert.ok(onBMemo, "the dial crossed devices into the memo, by event - not by backstop");
    });
});
