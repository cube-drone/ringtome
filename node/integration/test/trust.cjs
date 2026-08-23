/*
    Second-order edges (2026-08-16): the assembled graph, and the implicit fold over it.

    The design under test: `edge_graph` (node.db) mirrors what synced personas PUBLISH about
    each other - third-party facts, consented by construction, fed per FOLLOWS_PUBLIC
    frontier move. `implicit_edges` (the reader's own db) composes the reader's dials with
    their friends' published bands: min of the two, per (target, lane, introducer), the
    trust lane through the reader's TRUST dial, the taste lane through the reader's
    REBROADCAST dial - "my rebroadcast dial is what I think of their taste, and an implicit
    follow is a taste judgment". Withdrawal sweeps both memos: a vouch taken back recedes
    from the graph, and the compositions built on it recede from every reader's set.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = require("./helpers.cjs").settleWith(240);

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

(HOST_C ? describe : describe.skip)("the edge graph and the implicit fold", function () {
    this.timeout(1200000);

    let friend, friendRoot, cora, coraRoot;
    // Bare roots the friend vouches for - subjects need no presence, only a name.
    const target = "11".repeat(32);
    const targetLow = "22".repeat(32);
    const tasteTarget = "33".repeat(32);

    const dialOn = (who, root) => async (subject, register, value) =>
        who(`api/identity/${root}/private/kv/contact:${subject}/${register}`, {
            method: "PUT",
            body: JSON.stringify({ value }),
        });

    const implicitRows = async () => {
        const res = await cora(`api/identity/${coraRoot}/implicit`);
        assert.equal(res.status, 200, await res.clone().text());
        return (await res.json()).edges;
    };

    before(async function () {
        friend = await makeUserFetch({ prefix: "edgefriend" });
        friendRoot = (await (await friend("api/identity", { method: "POST" })).json()).root_pubkey;
        await friend(`api/identity/${friendRoot}/serve`, { method: "POST" });

        cora = await makeUserFetch({ prefix: "edgecora", host: HOST_C });
        coraRoot = (await (await cora("api/identity", { method: "POST" })).json()).root_pubkey;
        await cora(`api/identity/${coraRoot}/serve`, { method: "POST" });
    });

    it("a friend's vouches become implicit rows, composed and capped", async function () {
        // The friend vouches, publicly (edges_public rests open): two trust bands and one
        // interest band, minted onto their follows-public chain by the dial writes.
        const friendDial = dialOn(friend, friendRoot);
        await friendDial(target, "trust", "high");
        await friendDial(targetLow, "trust", "low");
        await friendDial(tasteTarget, "interest", "high");

        // Cora meets the friend: the fetch mirrors their chains - statements included - and
        // the dials make them an introducer. Trust high; rebroadcast LOW beside interest
        // HIGH, so the taste lane's cap proves it keys on the rebroadcast dial: if it read
        // the interest dial, the taste row below would come out high.
        const viaFriend = await base58(friend);
        if ((await cora(`api/id/${friendRoot}/profile?via=${viaFriend}`)).status !== 200)
            this.skip();
        const coraDial = dialOn(cora, coraRoot);
        await coraDial(friendRoot, "trust", "high");
        await coraDial(friendRoot, "interest", "high");
        await coraDial(friendRoot, "interest_rebroadcasts", "low");

        // The node half: the graph holds the friend's published statements.
        assert.ok(
            await settle(async () => {
                const { rows } = await sql(
                    `SELECT subject_root, trust, interest FROM edge_graph WHERE author_root = '${friendRoot}'`,
                    HOST_C
                );
                return rows.length >= 3 ? rows : null;
            }),
            "the friend's published edges assembled into the node-level graph"
        );

        // The user half: the compositions, each capped by its weaker side.
        const rows = await settle(async () => {
            const got = await implicitRows();
            return got.length >= 3 ? got : null;
        });
        assert.ok(rows, "the implicit fold produced rows");
        const find = (t, lane) => rows.find((r) => r.target_root === t && r.lane === lane);

        const strong = find(target, "trust");
        assert.ok(strong, "the high-trust vouch is an implicit row");
        assert.equal(strong.level, "high", "high dial x high vouch composes high");
        assert.equal(strong.introducer_root, friendRoot);
        assert.equal(strong.depth, 2);
        assert.equal(strong.introducer_vouches, 2, "the friend spends two trust vouches");

        const weak = find(targetLow, "trust");
        assert.equal(weak.level, "low", "the friend's low vouch caps the composition");

        const taste = find(tasteTarget, "taste");
        assert.ok(taste, "the interest vouch lands on the taste lane");
        assert.equal(
            taste.level,
            "low",
            "capped by cora's REBROADCAST dial, not her interest dial - taste is taste"
        );
        assert.equal(taste.introducer_vouches, 1, "one interest vouch spent");

        // Withdrawal: the friend takes the low vouch back. The retraction mints, the graph
        // row sweeps, and the composition built on it recedes from cora's set.
        await friendDial(targetLow, "trust", "");
        assert.ok(
            await settle(async () => {
                const { rows: graph } = await sql(
                    `SELECT 1 AS present FROM edge_graph WHERE author_root = '${friendRoot}' AND subject_root = '${targetLow}' AND trust IS NOT NULL`,
                    HOST_C
                );
                if (graph.length) return null;
                const implicit = await implicitRows();
                return implicit.some((r) => r.target_root === targetLow) ? null : true;
            }),
            "a withdrawn vouch recedes from the graph and from the implicit set"
        );
    });
});
