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
        const entriesB = (await (await aliceOnB(`api/identity/${root}/entries?limit=500`)).json()).items;
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

    it("a genesis repudiation strikes the impostor without losing the survivor's words", async function () {
        // The field scenario (2026-07-30): A and B share a notepad; a version chain runs
        // good(A) <- good(A) <- good(A) <- bad(B) <- good(A); then A repudiates B with the
        // genesis cut. B's version is struck - but A's final version survives ON A'S CHAIN,
        // and never-lose-words says the resolved document must still carry A's text.
        const alice = await makeUserFetch({ prefix: "goodbad" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const aliceOnB = await makeUserFetch({ prefix: "goodbadb", host: HOST_B });
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

        const save = async (fetch, docId, body, parents) => {
            const res = await fetch(`api/identity/${root}/docs/${docId}`, {
                method: "PUT",
                body: JSON.stringify({ title: "shared", body, parents, format: "plaintext" }),
            });
            assert.equal(res.status, 200);
            return (await res.json()).version;
        };
        const sync = async () => {
            const r = await (await alice(`api/identity/${root}/sync`, { method: "POST" })).json();
            assert.ok(r.some((x) => x.ok), "the nodes can talk");
        };

        // The chain: three goods on A, one bad on B, one more good on A atop the bad.
        const made = await (
            await alice(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "shared", body: "good1", format: "plaintext" }),
            })
        ).json();
        const doc = made.doc_id;
        const v1 = made.version;
        const v2 = await save(alice, doc, "good1\ngood2", [v1]);
        const v3 = await save(alice, doc, "good1\ngood2\ngood3", [v2]);
        await sync();
        const v4 = await save(aliceOnB, doc, "good1\ngood2\ngood3\nbad", [v3]);
        await sync();
        const v5 = await save(alice, doc, "good1\ngood2\ngood3\nbad\ngood5", [v4]);

        // Also the other two field observations: B defines a bucket and files A's doc in it,
        // and B spawns a document that A then improves.
        await aliceOnB(`api/identity/${root}/buckets`, {
            method: "POST",
            body: JSON.stringify({ name: "bs-bucket", app: "notes" }),
        });
        await aliceOnB(`api/identity/${root}/docs/${doc}/buckets/bs-bucket`, { method: "PUT" });
        const bMade = await (
            await aliceOnB(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "b-spawned", body: "b-genesis", format: "plaintext" }),
            })
        ).json();
        await sync();
        const aImprove = await save(alice, bMade.doc_id, "b-genesis\nplus-a", [bMade.version]);
        assert.ok(aImprove, "A improved B's document");

        // The strike: it was never B.
        await alice(`api/identity/${root}/keys/${leaf}/revoke`, {
            method: "POST",
            body: JSON.stringify({ disposition: "repudiation", cut: "genesis" }),
        });

        // The shared doc on A: v4 is struck; v3 and v5 both survive as heads (v5's parent
        // dangles - tolerated). Whatever shape resolution takes, A's words must be there.
        const after = await (await alice(`api/identity/${root}/docs/${doc}`)).json();
        assert.ok(after.body !== null && after.body !== "", "the resolved body is not empty");
        assert.ok(
            after.body.includes("good5"),
            `A's final words survive the strike (got: ${JSON.stringify(after.body).slice(0, 200)})`
        );
        assert.ok(
            after.body.includes("good3"),
            "the pre-bad history is still present in the resolution"
        );

        // B's spawned doc: its genesis version is struck, but A's improvement is A's -
        // signed by A, on A's chain - and must still be listed and readable.
        const bDocAfter = await (
            await alice(`api/identity/${root}/docs/${bMade.doc_id}`)
        ).json();
        assert.ok(
            bDocAfter.body && bDocAfter.body.includes("plus-a"),
            `A's improvement to B's doc survives (got: ${JSON.stringify(bDocAfter.body).slice(0, 200)})`
        );
        const list = await (await alice(`api/identity/${root}/docs`)).json();
        const listedIds = list.docs.map((d) => d.doc_id);
        assert.ok(listedIds.includes(doc), "the shared doc is still listed");
        assert.ok(listedIds.includes(bMade.doc_id), "the B-spawned doc with A content is still listed");
        const v5StillThere = v5; // silence nothing: v5 is the load-bearing survivor
        assert.ok(v5StillThere);
    });

    it("a revoked computer discovers its fate: standing, refused writes, and the detach", async function () {
        // The farewell flow's API half (2026-07-31): after its key is revoked, a
        // well-intentioned node should DISCOVER that - standing in the persona list - refuse
        // to keep signing (403 revoked-signer, not silent entries the network will refuse),
        // and be able to let go (the node-local detach).
        const alice = await makeUserFetch({ prefix: "farewell" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const aliceOnB = await makeUserFetch({ prefix: "farewellb", host: HOST_B });
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

        // A locks B out; B hears about it on its next sync.
        await alice(`api/identity/${root}/keys/${leaf}/revoke`, {
            method: "POST",
            body: JSON.stringify({ disposition: "repudiation" }),
        });
        await aliceOnB(`api/identity/${root}/sync`, { method: "POST" });

        // Discovery: the persona list carries this node's own standing.
        const personasB = await (await aliceOnB("api/identity")).json();
        assert.equal(personasB[0].standing, "repudiated", "B knows it was locked out");
        const personasA = await (await alice("api/identity")).json();
        assert.equal(personasA[0].standing, "active", "A is untouched");

        // Refusal: a revoked key may read its era; it may not speak.
        const write = await aliceOnB(`api/identity/${root}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "GHOST" }),
        });
        assert.equal(write.status, 403);
        const body = await write.json();
        assert.equal(body.code, "revoked-signer", "the refusal is structurally identifiable");

        // Reads still work - its era stays readable until it lets go.
        const profile = await (await aliceOnB(`api/identity/${root}/profile`)).json();
        assert.ok(Array.isArray(profile), "reading the era still works");

        // The detach: back to being a computer with nobody in it.
        const detached = await (
            await aliceOnB(`api/identity/${root}/detach`, { method: "POST" })
        ).json();
        assert.equal(detached.detached, true);
        assert.deepEqual(await (await aliceOnB("api/identity")).json(), [], "nobody lives here");
    });

    it("a serving record publishes at birth: universal publication, within budget", async function () {
        const dhtDir = process.env.RINGTOME_TEST_DISCOVERY_DIR;
        if (!dhtDir) this.skip();
        const fs = require("node:fs");

        const user = await makeUserFetch({ prefix: "servemark" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // Universal publication (the discoverability doctrine, 2026-08-07): participation
        // implies locatability, so creation publishes the founding leaf's record before the
        // POST even returns - "publication is an act" is retired for serving records, and
        // the dark-at-birth assertion that used to live here retired with it. Records are
        // keyed by LEAF; the founder's leaf is the root, which is what makes bare roots
        // resolvable at all.
        const recordPath = `${dhtDir}/s_${root}.bin`;
        assert.ok(fs.existsSync(recordPath), "a hosted identity is locatable from birth");
        assert.ok(fs.statSync(recordPath).size < 512, "records stay within the pkarr budget");

        // Marking served survives as the HTTP-face flag - still an act, no longer discovery.
        const resp = await (
            await user(`api/identity/${root}/serve`, { method: "POST" })
        ).json();
        assert.equal(resp.served, true);
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
