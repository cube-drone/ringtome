/*
    The transport gate proves itself: `/test/unplug` really stops traffic, per protocol and per
    direction, and a node comes back when plugged in.

    This file is the reason the gate can be trusted by the tests that will USE it (the rebroadcast
    node-death case first - NEXT_STEPS). A partition simulator that silently refused nothing would
    make every test built on it pass while proving the opposite of what it claims, so the gate is
    pinned here against a real two-node exchange rather than against its own report of itself.

    The probe throughout is an adopted identity and `POST /api/identity/{root}/sync`, whose response
    carries one `{ ok, error }` per peer: the cheapest thing in the suite that provably crosses the
    wire and says so. `helpers.js`-style choreography is deliberately kept to the minimum needed -
    twonode.cjs is where the sync story itself is told.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST, HOST_B, makeFetch } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { unplug, plugIn, refusals, withUnplugged } = require("./unplug.cjs");

// An identity on A that B has adopted, so the two nodes are genuine sync peers.
async function pairedIdentity(prefix) {
    const onA = await makeUserFetch({ prefix });
    const created = await (await onA("api/identity", { method: "POST" })).json();
    const root = created.root_pubkey;

    const onB = await makeUserFetch({ prefix: `${prefix}b`, host: HOST_B });
    const request = await (await onB("api/identity/adopt/begin", { method: "POST" })).json();
    const granted = await (
        await onA(`api/identity/${root}/nodes`, {
            method: "POST",
            body: JSON.stringify({ code: request.code }),
        })
    ).json();
    assert.equal(granted.delivered, true, "the pair was built over the wire");
    return { onA, onB, root };
}

// A's view of one sync round with its peers: one `{ peer, ok, error }` each.
async function syncFromA(onA, root) {
    return (await onA(`api/identity/${root}/sync`, { method: "POST" })).json();
}

describe("the transport gate (/test/unplug)", function () {
    // Two real processes, real QUIC, an adoption ceremony with argon2 in it.
    this.timeout(60000);

    describe("its vocabulary", function () {
        it("refuses everything, both ways, when asked for nothing in particular", async function () {
            const state = await unplug(HOST);
            try {
                assert.deepEqual(
                    state.inbound.slice().sort(),
                    ["adopt", "blob", "deliver", "fragment", "sync"],
                    "a bare unplug covers every protocol the node speaks"
                );
                assert.deepEqual(state.outbound.slice().sort(), state.inbound.slice().sort());
            } finally {
                await plugIn(HOST);
            }
        });

        it("reports what it is refusing without changing it", async function () {
            await unplug(HOST, { alpns: ["blob"], direction: "outbound" });
            try {
                const seen = await refusals(HOST);
                assert.deepEqual(seen, { inbound: [], outbound: ["blob"] });
                // Reading twice is reading, not toggling.
                assert.deepEqual(await refusals(HOST), seen);
            } finally {
                await plugIn(HOST);
            }
        });

        it("replaces the refusal set rather than adding to it", async function () {
            // The property a test relies on when it stops reasoning about what ran before it.
            await unplug(HOST, { alpns: ["sync"] });
            const second = await unplug(HOST, { alpns: ["blob"] });
            try {
                assert.deepEqual(second.inbound, ["blob"], "sync is no longer refused");
            } finally {
                await plugIn(HOST);
            }
            assert.deepEqual(await refusals(HOST), { inbound: [], outbound: [] });
        });

        it("plugging in is idempotent, and fine on a node that was never unplugged", async function () {
            assert.deepEqual(await plugIn(HOST), { inbound: [], outbound: [] });
            assert.deepEqual(await plugIn(HOST), { inbound: [], outbound: [] });
        });

        it("turns a typo into a 400, never a gate that refuses nothing", async function () {
            // The whole reason names are validated: `alpns: ["fragments"]` silently doing nothing
            // would produce a partition test that passes because there was no partition.
            const resp = await makeFetch(HOST)("test/unplug", {
                method: "POST",
                body: JSON.stringify({ alpns: ["fragments"] }),
            });
            assert.equal(resp.status, 400);
            assert.match(await resp.text(), /fragment/, "the answer lists what the node does speak");
            assert.deepEqual(await refusals(HOST), { inbound: [], outbound: [] }, "and nothing armed");
        });

        it("refuses a direction it does not have", async function () {
            const resp = await makeFetch(HOST)("test/unplug", {
                method: "POST",
                body: JSON.stringify({ direction: "sideways" }),
            });
            assert.equal(resp.status, 400);
            assert.deepEqual(await refusals(HOST), { inbound: [], outbound: [] });
        });
    });

    (HOST_B ? describe : describe.skip)("its effect on the wire", function () {
        it("an unplugged node stops answering, and answers again when plugged in", async function () {
            const { onA, root } = await pairedIdentity("gateinbound");

            // Baseline: the pair can talk. Without this the rest proves nothing - a red
            // assertion below could just mean the nodes never reached each other at all.
            assert.ok(
                (await syncFromA(onA, root)).some((r) => r.ok),
                "A reaches B before the partition"
            );

            await withUnplugged([HOST_B], async () => {
                const results = await syncFromA(onA, root);
                assert.ok(results.length > 0, "A still knows B exists");
                assert.ok(
                    results.every((r) => !r.ok),
                    `every exchange failed while B was unplugged (got ${JSON.stringify(results)})`
                );
            });

            // And the partition is over the moment the block is.
            assert.ok(
                (await syncFromA(onA, root)).some((r) => r.ok),
                "B answers again once plugged back in"
            );
        });

        it("refusing to DIAL is its own half: A goes quiet with B fully up", async function () {
            const { onA, root } = await pairedIdentity("gateoutbound");
            assert.ok((await syncFromA(onA, root)).some((r) => r.ok), "the pair can talk");

            // Only A is gated, and only outbound. B is healthy and listening throughout, so a
            // failure here can only be A declining to open the connection.
            await withUnplugged([HOST], async () => {
                const results = await syncFromA(onA, root);
                assert.ok(
                    results.every((r) => !r.ok),
                    `A dialled nobody (got ${JSON.stringify(results)})`
                );
                assert.ok(
                    results.every((r) => /unplugged/.test(r.error || "")),
                    `and said why in plain words (got ${JSON.stringify(results.map((r) => r.error))})`
                );
            }, { direction: "outbound" });

            assert.ok((await syncFromA(onA, root)).some((r) => r.ok), "A dials again afterwards");
        });

        it("is per protocol: refusing bodies leaves sync running", async function () {
            // The property the node-death test needs. If `alpns` were decorative and every
            // unplug were total, this sync would fail - so this is the assertion that catches a
            // gate which quietly ignores what it was asked to refuse.
            const { onA, root } = await pairedIdentity("gateselective");
            assert.ok((await syncFromA(onA, root)).some((r) => r.ok), "the pair can talk");

            await withUnplugged([HOST_B], async () => {
                assert.ok(
                    (await syncFromA(onA, root)).some((r) => r.ok),
                    "chains still move when only the blob protocol is refused"
                );
                assert.deepEqual((await refusals(HOST_B)).inbound, ["blob"]);
            }, { alpns: ["blob"] });
        });

        it("gates a protocol that is not sync: an ungranted adoption falls back to the code", async function () {
            // Proof the gate is not secretly sync-shaped. One-trip adoption dials the ADOPT
            // ALPN; with only that refused, delivery must fail and the ceremony must degrade to
            // its copy-paste fallback rather than break (twonode.cjs pins the happy path).
            const onA = await makeUserFetch({ prefix: "gateadopt" });
            const created = await (await onA("api/identity", { method: "POST" })).json();
            const root = created.root_pubkey;
            const onB = await makeUserFetch({ prefix: "gateadoptb", host: HOST_B });
            const request = await (await onB("api/identity/adopt/begin", { method: "POST" })).json();

            const grant = await withUnplugged(
                [HOST_B],
                async () =>
                    (await (
                        await onA(`api/identity/${root}/nodes`, {
                            method: "POST",
                            body: JSON.stringify({ code: request.code }),
                        })
                    ).json()),
                { alpns: ["adopt"] }
            );
            assert.equal(grant.delivered, false, "the wire could not carry it");
            assert.ok(grant.code, "and the human-carried code is still there to paste");

            // The fallback genuinely works once the cable is back - the ceremony was delayed,
            // not damaged.
            const completed = await onB("api/identity/adopt/complete", {
                method: "POST",
                body: JSON.stringify({ code: grant.code }),
            });
            assert.equal(completed.status, 200);
            assert.equal((await completed.json()).root_pubkey, root);
        });
    });
});
