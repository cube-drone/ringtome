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
