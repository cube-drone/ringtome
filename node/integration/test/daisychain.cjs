/*
    The daisy chain: a persona spread across three nodes where the chain of invitations does
    NOT route through the founder - A founds, B joins from A, then C joins *from B* (the
    un-trimmed junior grant: any Active key can extend the tree; the crown computes the
    usurper stamp at any depth).

    The load-bearing assertions: B's grant of C succeeds (this was a 403 for its whole life
    until now); C's leaf sits UNDER B's in the tree (rank path is B's + one more step - the
    tree records who vouched for whom); the whole chain converges (a write on C reaches A);
    every key renders named from every chair; and the day-one spare key still outranks and
    rescues the deepest link.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch, HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch, decodeCode } = require("./helpers.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adopt(joiner, granter, root) {
    const request = await (await joiner("api/identity/adopt/begin", { method: "POST" })).json();
    const leaf = decodeCode(request.code).leaf_pubkey;
    const res = await granter(`api/identity/${root}/nodes`, {
        method: "POST",
        body: JSON.stringify({ code: request.code }),
    });
    return { leaf, status: res.status, body: await res.json() };
}

(HOST_B && HOST_C ? describe : describe.skip)("the daisy chain (A → B → C)", function () {
    this.timeout(60000);

    it("a junior node grants; the tree, the sync, and the spare key all hold", async function () {
        // A founds.
        const alice = await makeUserFetch({ prefix: "daisy" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // B joins from A (the founder grant, as ever).
        const aliceOnB = await makeUserFetch({ prefix: "daisyb", host: HOST_B });
        const b = await adopt(aliceOnB, alice, root);
        assert.equal(b.status, 200);
        assert.equal(b.body.delivered, true);

        // C joins FROM B - the grant that used to be "v1: only the identity's root node".
        const aliceOnC = await makeUserFetch({ prefix: "daisyc", host: HOST_C });
        const c = await adopt(aliceOnC, aliceOnB, root);
        assert.equal(c.status, 200, JSON.stringify(c.body));
        assert.equal(c.body.delivered, true, "B delivered the grant to C over the wire");

        // The tree records the chain of vouching: C's leaf sits UNDER B's leaf.
        const treeOnC = await (await aliceOnC(`api/identity/${root}/keys`)).json();
        const bPath = treeOnC.keys.find((k) => k.pubkey === b.leaf).rank_path;
        const cPath = treeOnC.keys.find((k) => k.pubkey === c.leaf).rank_path;
        assert.deepEqual(
            cPath.slice(0, bPath.length),
            bPath,
            "C's rank path extends B's - the tree remembers who invited whom"
        );
        assert.equal(cPath.length, bPath.length + 1, "one step deeper, exactly");

        // Every key named, from the deepest chair: alpha founded, bravo and charlie joined.
        assert.equal(treeOnC.keys.find((k) => k.pubkey === root).name, "alpha");
        assert.equal(treeOnC.keys.find((k) => k.pubkey === b.leaf).name, "bravo");
        assert.equal(treeOnC.keys.find((k) => k.pubkey === c.leaf).name, "charlie");

        // And in responsibility order: the keys endpoint sorts by rank path, so the founder
        // leads, the spare key sits beside it, and each computer follows whoever vouched for
        // it - the order the "your computers" screen shows verbatim.
        assert.deepEqual(
            treeOnC.keys.map((k) => k.name),
            ["alpha", null, "bravo", "charlie"],
            "root, spare, then the invitation chain in vouching order"
        );

        // The chain converges end to end: a write on C surfaces on A (C's entries reach A
        // through the peer graph - eager push relays, no manual sync calls).
        await aliceOnC(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Daisy Chained" }),
        });
        let seen = null;
        for (let i = 0; i < 40 && !seen; i++) {
            const profile = await (await alice(`api/identity/${root}/profile`)).json();
            const row = profile.find((f) => f.field === "name");
            if (row && row.value === "Daisy Chained") seen = row;
            else await sleep(500);
        }
        assert.ok(seen, "C's write reached A across the daisy chain");

        // The day-one spare key rescues the deepest link: reset C's account password with the
        // seed minted on A - C verifies it from its synced tree, two hops from home.
        const resetRes = await makeFetch(HOST_C)("api/auth/recover", {
            method: "POST",
            body: JSON.stringify({
                username: aliceOnC.username,
                recovery_secret: created.recovery_secret,
                new_password: "daisy-chained-rescue",
            }),
        });
        assert.equal(resetRes.status, 200, "the tree-level spare key works at depth two");
    });
});
