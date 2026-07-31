/*
    The key tree over HTTP: identity creation mints a recovery key (returned exactly once, never
    persisted by the node), the identity chain's genesis is the recovery-key authorization, and
    the /keys endpoint exposes the resolved tree.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

describe("recovery key ceremony", function () {
    it("creation returns the recovery secret exactly once", async function () {
        const user = await makeUserFetch({ prefix: "recmint" });
        const created = await (await user("api/identity", { method: "POST" })).json();

        assert.match(created.root_pubkey, /^[0-9a-f]{64}$/);
        assert.match(created.recovery_pubkey, /^[0-9a-f]{64}$/);
        assert.match(created.recovery_secret, /^[0-9a-f]{64}$/, "32-byte seed, hex");
        assert.match(created.authorize_entry_hash, /^[0-9a-f]{64}$/);
        assert.notEqual(created.recovery_pubkey, created.root_pubkey);

        // The secret is not retrievable afterward: neither the identity list nor any other
        // surface carries it. (The node never persisted it - this asserts the API contract.)
        const list = await (await user("api/identity")).json();
        const mine = list.find((i) => i.root_pubkey === created.root_pubkey);
        assert.ok(mine, "identity is listed");
        assert.equal(mine.recovery_secret, undefined);
        assert.equal(mine.recovery_pubkey, undefined);
    });

    it("distinct identities get distinct recovery keys", async function () {
        const user = await makeUserFetch({ prefix: "recdupe" });
        const a = await (await user("api/identity", { method: "POST" })).json();
        const b = await (await user("api/identity", { method: "POST" })).json();
        assert.notEqual(a.recovery_pubkey, b.recovery_pubkey);
        assert.notEqual(a.recovery_secret, b.recovery_secret);
    });
});

describe("key tree endpoint", function () {
    it("shows root and recovery key with their rank paths", async function () {
        const user = await makeUserFetch({ prefix: "tree" });
        const created = await (await user("api/identity", { method: "POST" })).json();

        const tree = await (
            await user(`api/identity/${created.root_pubkey}/keys`)
        ).json();

        assert.equal(tree.root_pubkey, created.root_pubkey);
        assert.equal(tree.forks, 0);
        assert.equal(tree.keys.length, 2);

        const root = tree.keys.find((k) => k.pubkey === created.root_pubkey);
        const recovery = tree.keys.find((k) => k.pubkey === created.recovery_pubkey);
        // The founding key is born named after its node (the integration node boots as
        // "alpha"); the recovery key is a role, not a device - no name, rendered by rank.
        // Removal is what THIS node may do: its own working key (the root, here) can leave;
        // the spare key is junior to the root, so the crown's node could lock it out.
        assert.deepEqual(root, {
            pubkey: created.root_pubkey,
            status: "active",
            rank_path: [],
            name: "alpha",
            removal: "self",
        });
        assert.deepEqual(recovery, {
            pubkey: created.recovery_pubkey,
            status: "active",
            rank_path: [0],
            name: null,
            removal: "senior",
        });
    });

    it("is owner-gated like the rest of the identity surface", async function () {
        const alice = await makeUserFetch({ prefix: "treealice" });
        const mallory = await makeUserFetch({ prefix: "treemal" });
        const created = await (await alice("api/identity", { method: "POST" })).json();

        const resp = await mallory(`api/identity/${created.root_pubkey}/keys`);
        assert.equal(resp.status, 404);
    });

    it("the genesis entry survives a rebuild (the tree is derived from the log)", async function () {
        const user = await makeUserFetch({ prefix: "treereb" });
        const created = await (await user("api/identity", { method: "POST" })).json();

        await user(`api/identity/${created.root_pubkey}/rebuild`, { method: "POST" });
        const tree = await (
            await user(`api/identity/${created.root_pubkey}/keys`)
        ).json();
        assert.equal(tree.keys.length, 2, "tree unchanged after replaying the log");
    });
});
