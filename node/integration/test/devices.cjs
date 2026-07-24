/*
    Device names: private labels for an identity's own keys (PROJECT_PLAN, Device Names) -
    "macbook-curtis", not dd7ee7d7. The load-bearing behaviors: identity creation labels the
    founding key with the node's configured name (the integration nodes boot as "alpha" and
    "bravo"); the keys endpoint carries names beside pubkeys; rename rides the ordinary private
    KV route because a label IS a private register; adoption's completing node labels its own
    new key, and the label syncs back so every node agrees what every device is called.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch, decodeCode } = require("./helpers.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function keys(fetch, root) {
    const res = await fetch(`api/identity/${root}/keys`);
    assert.equal(res.status, 200);
    return (await res.json()).keys;
}

describe("device names: what keys are called", function () {
    this.timeout(30000);

    it("creation names the founding key after the node; rename is a KV write", async function () {
        const user = await makeUserFetch({ prefix: "devname" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        // The founding key (root doubles as the creating node's leaf) is born named.
        let tree = await keys(user, root);
        const rootKey = tree.find((k) => k.pubkey === root);
        assert.equal(rootKey.name, "alpha", "founding key carries the node's name");

        // The recovery key is a role, not a device: born unnamed, rendered by rank.
        const recovery = tree.find((k) => k.pubkey === created.recovery_pubkey);
        assert.equal(recovery.name, null, "recovery key has no device name");

        // Rename is an ordinary private register write - no bespoke route.
        const rename = await user(`api/identity/${root}/private/kv/devices/${root}`, {
            method: "PUT",
            body: JSON.stringify({ value: "the-study-machine" }),
        });
        assert.equal(rename.status, 200);
        tree = await keys(user, root);
        assert.equal(tree.find((k) => k.pubkey === root).name, "the-study-machine");
    });
});

(HOST_B ? describe : describe.skip)("device names across two nodes", function () {
    this.timeout(60000);

    it("an adopted node names its own key, and both nodes agree", async function () {
        const alice = await makeUserFetch({ prefix: "devtwo" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const aliceOnB = await makeUserFetch({ prefix: "devtwob", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
        // The request code is a JSON envelope; B's minted leaf pubkey rides inside it.
        const leafPubkey = decodeCode(request.code).leaf_pubkey;
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

        // B labeled its own key during adoption, and sees A's founding label via the synced
        // private chain: the whole tree is named from B's chair.
        const treeOnB = await keys(aliceOnB, root);
        const leafOnB = treeOnB.find((k) => k.pubkey === leafPubkey);
        assert.equal(leafOnB.name, "bravo", "the adopted node named itself");
        assert.equal(
            treeOnB.find((k) => k.pubkey === root).name,
            "alpha",
            "A's founding label arrived with the private chains"
        );

        // A learns B's label once B's write syncs back (eager push; poll briefly).
        let named = null;
        for (let i = 0; i < 20 && !named; i++) {
            const treeOnA = await keys(alice, root);
            const leaf = treeOnA.find((k) => k.pubkey === leafPubkey);
            if (leaf && leaf.name === "bravo") named = leaf;
            else await sleep(500);
        }
        assert.ok(named, "A sees B's self-label after sync");
    });
});
