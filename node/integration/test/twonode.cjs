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
const { makeUserFetch, decodeCode } = require("./helpers.cjs");

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
        const leaf = decodeCode(request.code).leaf_pubkey;

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

    it("a self-retirement crosses the gate and is remembered", async function () {
        // A revoke can never anchor itself, so a self-retirement sits beyond its own seal -
        // and an adopted leaf usually has no identity history at all, making the revoke its
        // chain's only entry, with nothing anchored. Regression: A's gate refused that entry,
        // so the retirement never persisted on A and the trashed key looked active again.
        const alice = await makeUserFetch({ prefix: "retiree" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        await setField(alice, root, "name", "Going Away");

        const aliceOnB = await makeUserFetch({ prefix: "retireeb", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const leaf = decodeCode(request.code).leaf_pubkey;
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

        // B decommissions itself: the friendly disposition, signed by the departing key.
        const retire = await (
            await aliceOnB(`api/identity/${root}/keys/${leaf}/revoke`, {
                method: "POST",
                body: JSON.stringify({ disposition: "retirement" }),
            })
        ).json();
        assert.match(retire.entry_hash, /^[0-9a-f]{64}$/);

        // A pulls; the retirement must cross the gate and land in storage.
        const syncResults = await (
            await alice(`api/identity/${root}/sync`, { method: "POST" })
        ).json();
        assert.ok(syncResults.some((r) => r.ok), "A reached at least one peer");
        const treeA = await (await alice(`api/identity/${root}/keys`)).json();
        assert.equal(
            treeA.keys.find((k) => k.pubkey === leaf).status,
            "retired",
            "the self-retirement is stored on A, not just resolved in passing"
        );

        // And it is memory, not a lucky in-flight view: a fresh exchange with nothing new
        // still shows the seal.
        await alice(`api/identity/${root}/sync`, { method: "POST" });
        const treeAgain = await (await alice(`api/identity/${root}/keys`)).json();
        assert.equal(treeAgain.keys.find((k) => k.pubkey === leaf).status, "retired");
    });

    it("removal capability and the genesis cut: 'it was never me' strikes the record", async function () {
        // The Computers screen's trash icon is gated by the per-key `removal` field (authority
        // decided server-side, never re-derived in JS), and a repudiation may choose its
        // cut-point: "now" (anchored heads - it was me until this moment) or "genesis"
        // (anchors nothing - it was never me, and everything it signed is swept).
        const alice = await makeUserFetch({ prefix: "neverme" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;
        await setField(alice, root, "name", "The Real One");

        const aliceOnB = await makeUserFetch({ prefix: "nevermeb", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        const leaf = decodeCode(request.code).leaf_pubkey;
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

        // Removal capability, from each side of the tree. On A (the crown's node): its own
        // key is "self", the junior leaf is "senior". On B: its own leaf is "self", and the
        // crown - senior to B - offers no removal at all.
        const treeOnA = await (await alice(`api/identity/${root}/keys`)).json();
        assert.equal(treeOnA.keys.find((k) => k.pubkey === root).removal, "self");
        assert.equal(treeOnA.keys.find((k) => k.pubkey === leaf).removal, "senior");
        const treeOnB = await (await aliceOnB(`api/identity/${root}/keys`)).json();
        assert.equal(treeOnB.keys.find((k) => k.pubkey === leaf).removal, "self");
        assert.equal(treeOnB.keys.find((k) => k.pubkey === root).removal, undefined);

        // B speaks - both nodes agree it's the latest word.
        await setField(aliceOnB, root, "name", "The Impostor");
        await alice(`api/identity/${root}/sync`, { method: "POST" });
        assert.equal(await profileValue(alice, root, "name"), "The Impostor");

        // Guardrail: a retirement cannot claim "it was never me" - that contradicts what a
        // retirement is.
        const contradiction = await alice(`api/identity/${root}/keys/${leaf}/revoke`, {
            method: "POST",
            body: JSON.stringify({ disposition: "retirement", cut: "genesis" }),
        });
        assert.equal(contradiction.status, 400);

        // The genesis cut: everything the leaf ever signed is struck, on the revoking node
        // immediately (the revoke route runs the gate's sweep on its own store)...
        const revoke = await (
            await alice(`api/identity/${root}/keys/${leaf}/revoke`, {
                method: "POST",
                body: JSON.stringify({ disposition: "repudiation", cut: "genesis" }),
            })
        ).json();
        assert.match(revoke.entry_hash, /^[0-9a-f]{64}$/);
        assert.equal(
            await profileValue(alice, root, "name"),
            "The Real One",
            "the impostor's write is struck from A's record"
        );

        // ...and on every other node as the revocation syncs in - including the impostor's
        // own, whose gate evicts its unanchored chains and rebuilds the views.
        await aliceOnB(`api/identity/${root}/sync`, { method: "POST" });
        assert.equal(
            await profileValue(aliceOnB, root, "name"),
            "The Real One",
            "B's own record converges on the surviving history"
        );
        const treeAfter = await (await alice(`api/identity/${root}/keys`)).json();
        assert.equal(treeAfter.keys.find((k) => k.pubkey === leaf).status, "repudiated");
    });

    it("serving is an act: no record until marked, a signed record after", async function () {
        const dhtDir = process.env.RINGTOME_TEST_DISCOVERY_DIR;
        if (!dhtDir) this.skip();
        const fs = require("node:fs");

        const user = await makeUserFetch({ prefix: "servemark" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // Dark at birth: no serving record exists for this identity's leaf (= root on the
        // creating node).
        const recordPath = `${dhtDir}/s_${root}.bin`;
        assert.ok(!fs.existsSync(recordPath), "unpublished identities leave no record");

        const resp = await (
            await user(`api/identity/${root}/serve`, { method: "POST" })
        ).json();
        assert.equal(resp.served, true);
        assert.ok(fs.existsSync(recordPath), "the publication act writes the signed record");
        assert.ok(fs.statSync(recordPath).size < 512, "records stay within the pkarr budget");
    });

    // "junior nodes cannot grant adoption in v1" lived here until 2026-07-24, when the M3
    // trim was un-trimmed: any Active key extends the tree now. The positive story - B
    // granting C, rank paths, convergence - lives in daisychain.cjs.
});

(HOST_B ? describe : describe.skip)("one-trip adoption", function () {
    this.timeout(60000);

    it("the grant travels by wire: delivered=true and the persona is already home", async function () {
        const alice = await makeUserFetch({ prefix: "onetrip" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const aliceOnB = await makeUserFetch({ prefix: "onetripb", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();

        // Granting now hands the grant straight to B over the adopt ALPN; the ack arrives
        // only after B fully completed, so delivered:true means the ceremony is DONE.
        const grantRes = await alice(`api/identity/${root}/nodes`, {
            method: "POST",
            body: JSON.stringify({ code: request.code }),
        });
        assert.equal(grantRes.status, 200);
        const grant = await grantRes.json();
        assert.equal(grant.delivered, true, "the wire carried it");
        assert.ok(grant.code, "the fallback code still rides along");

        // Nobody called adopt/complete - yet B already agents the persona, fully synced,
        // self-named. The second courier trip is gone.
        const personas = await (await aliceOnB("api/identity")).json();
        assert.deepEqual(
            personas.map((i) => i.root_pubkey),
            [root],
            "B is already home without a complete call"
        );
        const tree = await (await aliceOnB(`api/identity/${root}/keys`)).json();
        const leaf = tree.keys.find((k) => k.pubkey === decodeCode(request.code).leaf_pubkey);
        assert.equal(leaf.name, "bravo", "completion ran in full: the new key named itself");

        // Pasting the fallback code anyway confirms rather than fails: completion is
        // idempotent, because the wire beating the human to it is now the COMMON case.
        const manual = await aliceOnB("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });
        assert.equal(manual.status, 200, "manual complete after delivery confirms, never 404s");
        assert.equal((await manual.json()).root_pubkey, root);
    });
});
