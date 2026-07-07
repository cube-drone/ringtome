/*
    The M3 exit demo: two nodes, one identity.

    Create an identity on node A; adopt node B via the request-code/grant-code ceremony; write on
    B and read it from A; confirm B holds a full independent copy (the kill-A property, by
    construction); then repudiate B's leaf from A and watch A's gate refuse B's subsequent writes.

    Skips itself when the harness only booted one node (RINGTOME_TEST_HOST_B unset).
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

async function setField(fetch, root, field, value) {
    return fetch(`api/identity/${root}/profile`, {
        method: "POST",
        body: JSON.stringify({ field, value }),
    });
}

async function profileValue(fetch, root, field) {
    const profile = await (await fetch(`api/identity/${root}/profile`)).json();
    const row = profile.find((f) => f.field === field);
    return row ? row.value : undefined;
}

(HOST_B ? describe : describe.skip)("two nodes, one identity (M3 exit demo)", function () {
    // Real networking + argon2 + two processes: give it room.
    this.timeout(60000);

    it("adopts, syncs, survives, and evicts", async function () {
        // --- Act 1: an identity is born on node A, with a name.
        const alice = await makeUserFetch({ prefix: "syncalice" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        await setField(alice, root, "name", "Hats Ahoy");

        // --- Act 2: the add-a-node ceremony (two copy-pastes).
        const aliceOnB = await makeUserFetch({ prefix: "syncaliceb", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const leaf = JSON.parse(request.code).leaf_pubkey;

        const grant = await (
            await alice(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();

        const adopted = await (
            await aliceOnB("api/identity/adopt/complete", {
                method: "POST",
                body: JSON.stringify({ code: grant.code }),
            })
        ).json();
        assert.equal(adopted.root_pubkey, root, "B now agents the same identity");

        // B synced the profile during adoption.
        assert.equal(await profileValue(aliceOnB, root, "name"), "Hats Ahoy");

        // B's view of the tree: root, recovery, and its own leaf.
        const treeB = await (await aliceOnB(`api/identity/${root}/keys`)).json();
        assert.equal(treeB.keys.length, 3);
        assert.equal(treeB.keys.find((k) => k.pubkey === leaf).status, "active");

        // --- Act 3: write on B, sync, read on A.
        await setField(aliceOnB, root, "name", "Hat Fan");
        const syncResults = await (
            await alice(`api/identity/${root}/sync`, { method: "POST" })
        ).json();
        assert.ok(syncResults.some((r) => r.ok), "A reached at least one peer");
        assert.equal(await profileValue(alice, root, "name"), "Hat Fan");

        // --- Act 4: the kill-A property, by construction: B holds a full, independent copy
        // (identity genesis + its own chains + everything synced from A). If A vanished now, B
        // has all of it locally.
        const entriesB = await (await aliceOnB(`api/identity/${root}/entries`)).json();
        assert.ok(
            entriesB.filter((e) => e.service === 0).length >= 1,
            "B holds the identity chain"
        );
        assert.ok(
            entriesB.filter((e) => e.service === 2).length >= 2,
            "B holds the full profile history from both nodes"
        );

        // --- Act 5: eviction. A repudiates B's leaf; B's later writes are refused by A's gate.
        const revoke = await (
            await alice(`api/identity/${root}/keys/${leaf}/revoke`, {
                method: "POST",
                body: JSON.stringify({ disposition: "repudiation" }),
            })
        ).json();
        assert.match(revoke.entry_hash, /^[0-9a-f]{64}$/);

        await setField(aliceOnB, root, "name", "EVIL TWIN");
        const postRevokeSync = await (
            await alice(`api/identity/${root}/sync`, { method: "POST" })
        ).json();
        assert.ok(postRevokeSync.some((r) => r.ok), "sync itself still succeeds");

        assert.equal(
            await profileValue(alice, root, "name"),
            "Hat Fan",
            "the repudiated key's post-anchor write must not cross A's gate"
        );

        // And A's tree agrees about why.
        const treeA = await (await alice(`api/identity/${root}/keys`)).json();
        assert.equal(treeA.keys.find((k) => k.pubkey === leaf).status, "repudiated");
    });

    it("junior nodes cannot grant adoption in v1", async function () {
        // A second joining node asks *B* (a leaf-holding node) to authorize it: refused.
        const alice = await makeUserFetch({ prefix: "grantalice" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const aliceOnB = await makeUserFetch({ prefix: "grantaliceb", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const grant = await (
            await alice(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        await aliceOnB("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });

        // Now a third would-be node asks B for authorization; B holds a leaf, not the root.
        const request2 = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const refused = await aliceOnB(`api/identity/${root}/nodes`, {
            method: "POST",
            body: JSON.stringify({ code: request2.code }),
        });
        assert.equal(refused.status, 403);
    });
});
