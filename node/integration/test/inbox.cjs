/*
    The DELIVERED path, end to end across two nodes (PROJECT_PLAN, Arrival and Attention).

    The case this exists for: a stranger follows you. There is no follow-edge, so nothing of
    theirs is being synced to you and the derived fold can never see it - the fact has to be
    carried to your door in an envelope, judged there, and transcribed onto your own inbox
    chain by your own node.

    What each test pins:
      - the outbox queues a knock when an edge is published toward someone;
      - the envelope reaches the recipient's node, passes the gate, and lands as a notice;
      - the bell shows it as a STRANGER row, with no byline (an unadmitted stranger renders
        from their root alone - claimed identity costs a sync);
      - a blocked sender is refused before anything is signed;
      - and the follow-edge rule holds from the other side: a sender the recipient already
        pulls produces no inbox row at all.
*/
const assert = require("node:assert");
const { sql, sql: sqlOn, HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = async (fn, tries = 80) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

const dial = (fetcher, mine, theirs, key, value) =>
    fetcher(`api/identity/${mine}/private/kv/contact:${theirs}/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
    });

// The inbox view lives in the RECIPIENT's per-user database, which the raw-SQL passthrough
// does not reach (it speaks to node.db). So the notice is observed the way a person would:
// through the bell.
const bell = async (fetcher, root) =>
    (await (await fetcher(`api/identity/${root}/notifications`)).json()).items || [];

(HOST_B ? describe : describe.skip)("a stranger's follow arrives by envelope", function () {
    this.timeout(120000);

    let host, hostRoot, stranger, strangerRoot, endpointOfHost;

    before(async function () {
        // The recipient lives on node A, the sender on node B - genuinely different machines,
        // which is the only way the delivery transport is actually exercised.
        host = await makeUserFetch({ prefix: "inboxhost" });
        hostRoot = (await (await host("api/identity", { method: "POST" })).json()).root_pubkey;
        // Serve it, so the sender can find a node that speaks for this root.
        await host(`api/identity/${hostRoot}/serve`, { method: "POST" });
        endpointOfHost = (await (await host("api/node")).json()).endpoint_id;

        stranger = await makeUserFetch({ prefix: "inboxstranger", host: HOST_B });
        strangerRoot = (await (await stranger("api/identity", { method: "POST" })).json())
            .root_pubkey;

        // The sender looks the recipient up - the ordinary way you come to follow somebody,
        // and what teaches their node an address to knock at later.
        const seen = await stranger(`api/id/${hostRoot}/profile?via=${endpointOfHost}`);
        if (seen.status !== 200) this.skip(); // no route between the two nodes; nothing to test
    });

    it("the envelope lands, and the bell shows it as a stranger", async () => {
        await dial(stranger, strangerRoot, hostRoot, "interest", "high");
        const row = await settle(async () => {
            const items = await bell(host, hostRoot);
            return items.find((i) => i.author === strangerRoot) || null;
        });
        assert.ok(row, "a notice from someone we do not sync reached the inbox");
        assert.equal(row.kind, "public-edge");
        assert.equal(row.interest, "high", "carrying the band the sender published");
        assert.equal(row.stranger, true, "and honestly marked as arrived, not derived");
        assert.equal(
            row.author_name,
            undefined,
            "an unadmitted stranger renders from their root alone - no byline is fetched"
        );
    });

    /*
        Note there is deliberately no "the row appears in the outbox" test. Delivery is EAGER -
        the knock goes out in the same breath as the mint - so a queued row is a state that
        exists for milliseconds and racing it would be a flaky test of nothing. What matters is
        observable at the ends: the notice arrives (above), the ledger empties (here), and an
        UNREACHABLE recipient leaves a row that climbs the ladder (below).
    */
    it("the knock is retired once it lands - a delivered notice is not redelivered", async () => {
        const gone = await settle(async () => {
            const { rows } = await sqlOn(
                `SELECT COUNT(*) AS n FROM outbound_notices WHERE sender_root = '${strangerRoot}'`,
                HOST_B
            );
            return rows[0] && rows[0].n === 0 ? true : null;
        });
        assert.ok(gone, "an answered knock leaves the ledger");
    });

    it("the recipient's own node signed the notice - the sender never wrote the chain", async () => {
        // Single-writer is the invariant the whole delivered path is shaped around. The inbox
        // chains belong to the RECIPIENT's leaf; a stranger's key must appear nowhere in them.
        const { rows } = await sql(
            `SELECT DISTINCT author_pubkey FROM chain_heads
             WHERE root_pubkey = '${hostRoot}' AND service IN (8, 9)`
        );
        assert.ok(rows.length > 0, "an inbox chain exists");
        for (const r of rows) {
            assert.notEqual(
                r.author_pubkey,
                strangerRoot,
                "a stranger cannot be the author of anything on your chains"
            );
        }
    });
});

(HOST_B ? describe : describe.skip)("the gate refuses what it should", function () {
    this.timeout(120000);

    let host, hostRoot, blocked, blockedRoot;

    before(async function () {
        host = await makeUserFetch({ prefix: "gatehost" });
        hostRoot = (await (await host("api/identity", { method: "POST" })).json()).root_pubkey;
        await host(`api/identity/${hostRoot}/serve`, { method: "POST" });
        const endpoint = (await (await host("api/node")).json()).endpoint_id;

        blocked = await makeUserFetch({ prefix: "gateblocked", host: HOST_B });
        blockedRoot = (await (await blocked("api/identity", { method: "POST" })).json())
            .root_pubkey;
        const seen = await blocked(`api/id/${hostRoot}/profile?via=${endpoint}`);
        if (seen.status !== 200) this.skip();

        // The recipient blocks them BEFORE they ever knock.
        await dial(host, hostRoot, blockedRoot, "blocked", "yes");
    });

    it("a blocked sender's notice is refused before anything is signed", async () => {
        await dial(blocked, blockedRoot, hostRoot, "interest", "max");
        // Give the eager delivery a real chance to have happened and been refused.
        await new Promise((r) => setTimeout(r, 6000));
        const items = await bell(host, hostRoot);
        assert.equal(
            items.filter((i) => i.author === blockedRoot).length,
            0,
            "a block is enforced at transcription, on every door"
        );
        // And the sender stops asking: a refusal is an answer, so the knock is retired rather
        // than climbing the backoff ladder forever.
        const done = await settle(async () => {
            const { rows } = await sqlOn(
                `SELECT COUNT(*) AS n FROM outbound_notices WHERE sender_root = '${blockedRoot}'`,
                HOST_B
            );
            return rows[0] && rows[0].n === 0 ? true : null;
        });
        assert.ok(done, "a refused knock is retired, never retried");
    });
});

describe("an undeliverable notice waits", function () {
    this.timeout(120000);

    it("a knock at a door that does not exist stays queued and climbs the ladder", async () => {
        // The stable half of the outbox: nobody anywhere serves this root, so every attempt
        // comes back Unreachable and the row survives with its try count advanced. This is the
        // case the backoff exists for - a recipient whose phone is simply asleep.
        const sender = await makeUserFetch({ prefix: "voidsender" });
        const senderRoot = (await (await sender("api/identity", { method: "POST" })).json())
            .root_pubkey;
        const nowhere = "ab".repeat(32);

        await dial(sender, senderRoot, nowhere, "interest", "medium");
        const row = await settle(async () => {
            const { rows } = await sql(
                `SELECT recipient_root, kind, tries FROM outbound_notices
                 WHERE sender_root = '${senderRoot}' AND recipient_root = '${nowhere}'`
            );
            return rows.length ? rows[0] : null;
        });
        assert.ok(row, "the envelope is waiting for a door to open");
        assert.equal(row.kind, "public-edge");
        assert.ok(row.tries >= 1, "and the eager attempt already counted against the backoff");
    });
});

describe("the follow-edge rule, from the delivered side", function () {
    this.timeout(120000);

    it("a sender the recipient already pulls produces no inbox row", async () => {
        // Two personas on ONE node, so the in-process door is exercised: the recipient follows
        // the sender, so the sender's statement is something the recipient's fold will derive.
        // An envelope for it would be a second surface for one fact.
        const reader = await makeUserFetch({ prefix: "pulledreader" });
        const readerRoot = (await (await reader("api/identity", { method: "POST" })).json())
            .root_pubkey;
        const author = await makeUserFetch({ prefix: "pulledauthor" });
        const authorRoot = (await (await author("api/identity", { method: "POST" })).json())
            .root_pubkey;

        // The reader follows the author: now the author's chains are pulled here.
        await dial(reader, readerRoot, authorRoot, "interest", "high");
        await settle(async () => {
            const { rows } = await sql(
                `SELECT 1 AS ok FROM subscriptions
                 WHERE local_root = '${readerRoot}' AND foreign_root = '${authorRoot}'`
            );
            return rows.length ? true : null;
        });

        // Now the author publishes an edge naming the reader.
        await dial(author, authorRoot, readerRoot, "interest", "max");

        const derived = await settle(async () => {
            const items = await bell(reader, readerRoot);
            return items.find((i) => i.author === authorRoot) || null;
        });
        assert.ok(derived, "the reader hears about it - by the DERIVED path");
        assert.equal(
            derived.stranger,
            undefined,
            "derived rows are not marked stranger, and carry a byline instead"
        );
    });
});
