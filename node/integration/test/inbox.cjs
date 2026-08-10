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
      - a blocked sender's notice is dropped before anything is signed, and they are told
        "accepted" anyway (2026-08-10: a spoken refusal would be a block oracle - the wire
        answer itself is pinned in `net::deliver::wire_answer`, since from out here a block is
        deliberately indistinguishable from acceptance);
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

(HOST_B ? describe : describe.skip)("the gate drops what it should", function () {
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

    it("a blocked sender's notice is dropped, and they are told nothing about it", async () => {
        await dial(blocked, blockedRoot, hostRoot, "interest", "max");
        // Give the eager delivery a real chance to have happened and been dropped.
        await new Promise((r) => setTimeout(r, 6000));
        const items = await bell(host, hostRoot);
        assert.equal(
            items.filter((i) => i.author === blockedRoot).length,
            0,
            "a block is enforced at transcription, on every door"
        );
        // And the sender stops asking: "accepted" is an answer, so the knock is retired rather
        // than climbing the backoff ladder forever. Note that this assertion passes identically
        // for a transcribed notice - which is the property, not a weakness of the test. What
        // separates the two cases is the bell row above, visible only to the recipient.
        const done = await settle(async () => {
            const { rows } = await sqlOn(
                `SELECT COUNT(*) AS n FROM outbound_notices WHERE sender_root = '${blockedRoot}'`,
                HOST_B
            );
            return rows[0] && rows[0].n === 0 ? true : null;
        });
        assert.ok(done, "an answered knock is retired, never retried");
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

/*
    The ring. The integration rig boots every node with RINGTOME_TEST_INBOX_KEEP=4, because
    the real depths (512/2048) are correct for the world and untestable in a suite - eviction
    at production depth would need thousands of transcriptions to observe once.
*/
describe("the stranger pool is a ring, and friends are not in it", function () {
    this.timeout(180000);

    it("a flood of strangers evicts only the oldest strangers", async () => {
        const host = await makeUserFetch({ prefix: "ringhost" });
        const hostRoot = (await (await host("api/identity", { method: "POST" })).json())
            .root_pubkey;

        // One TRUSTED sender: the host records a trust band for them (no interest - an
        // interest band would make them a follow, and their notice would be discarded as
        // already-pulled rather than filed in the trusted tier).
        const friend = await makeUserFetch({ prefix: "ringfriend" });
        const friendRoot = (await (await friend("api/identity", { method: "POST" })).json())
            .root_pubkey;
        await dial(host, hostRoot, friendRoot, "trust", "high");
        await dial(friend, friendRoot, hostRoot, "interest", "high");
        const friendRow = await settle(async () => {
            const items = await bell(host, hostRoot);
            return items.find((i) => i.author === friendRoot) || null;
        });
        assert.ok(friendRow, "the friend's notice landed, in the trusted tier");

        // Now seven strangers, one after another - the pool holds four.
        const strangers = [];
        for (let n = 0; n < 7; n++) {
            const s = await makeUserFetch({ prefix: `ringstranger${n}` });
            const root = (await (await s("api/identity", { method: "POST" })).json()).root_pubkey;
            strangers.push(root);
            await dial(s, root, hostRoot, "interest", "medium");
            // Wait for THIS notice to land before sending the next: the test is about the
            // ring turning, not about racing seven eager sweeps.
            const landed = await settle(async () => {
                const items = await bell(host, hostRoot);
                return items.some((i) => i.author === root) ? true : null;
            });
            assert.ok(landed, `stranger ${n} was transcribed`);
        }

        const items = await bell(host, hostRoot);
        const strangerRows = items.filter((i) => strangers.includes(i.author));
        assert.ok(
            strangerRows.length <= 4,
            `the pool holds its depth (saw ${strangerRows.length} stranger rows)`
        );
        assert.ok(
            strangerRows.some((i) => i.author === strangers[6]),
            "the newest stranger is present - the ring admits, it never shuts"
        );
        assert.ok(
            !strangerRows.some((i) => i.author === strangers[0]),
            "the oldest stranger aged off the floor"
        );
        assert.ok(
            items.some((i) => i.author === friendRoot),
            "and the flood never touched the friend - the tiers are different chains"
        );
    });
});

(HOST_B ? describe : describe.skip)("a pruned inbox survives adoption", function () {
    this.timeout(180000);

    it("a fresh device admits the suffix a pruned chain honestly offers", async () => {
        // The failure this feature must not ship with: node A prunes the inbox chain to its
        // floor; the persona is then adopted onto fresh node B; B receives a chain starting
        // above seq 0. Without suffix admission B rejects every entry and the bell on the
        // new device is empty forever.
        const onA = await makeUserFetch({ prefix: "prunedhost" });
        const root = (await (await onA("api/identity", { method: "POST" })).json()).root_pubkey;

        // Six strangers through the ring (keep=4): guarantees the chain is genuinely pruned,
        // not merely full.
        const strangers = [];
        for (let n = 0; n < 6; n++) {
            const s = await makeUserFetch({ prefix: `prunestranger${n}` });
            const sRoot = (await (await s("api/identity", { method: "POST" })).json())
                .root_pubkey;
            strangers.push(sRoot);
            await dial(s, sRoot, root, "interest", "low");
            const landed = await settle(async () => {
                const items = await bell(onA, root);
                return items.some((i) => i.author === sRoot) ? true : null;
            });
            assert.ok(landed, `stranger ${n} was transcribed`);
        }

        // The adoption ceremony: the persona grows a second device on node B.
        const onB = await makeUserFetch({ prefix: "pruneddevice", host: HOST_B });
        const request = await (await onB("api/identity/adopt/begin", { method: "POST" })).json();
        const grant = await (
            await onA(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        const done = await onB("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });
        assert.equal(done.status, 200, await done.text());

        // The new device must see the surviving notices - which requires its gate to have
        // admitted an inbox chain that starts at the floor A pruned to.
        const seen = await settle(async () => {
            const items = await bell(onB, root);
            return items.some((i) => i.author === strangers[5]) ? items : null;
        }, 120);
        assert.ok(seen, "the pruned chain crossed to the new device as a suffix");
        assert.ok(
            !seen.some((i) => i.author === strangers[0]),
            "and what aged off the floor stayed gone - pruning is not a per-device opinion"
        );
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
