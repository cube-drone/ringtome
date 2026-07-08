/*
    Private chains: the member-only encrypted KV + set store.

    Single-node: registers and sets round-trip, LWW converges, and the stored entries are
    ciphertext (the plaintext value never appears in the log bytes).

    Two-node (the Tier-5 "private chains" exit demo): adoption carries the private state to the
    new node; private writes flow both ways between member-proven nodes; revocation rotates the
    epoch, after which the evicted node keeps reading its era and receives nothing from the
    future - forward secrecy at the sync gate, not by politeness.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const PRIVATE_SERVICE = 5;

async function putKv(fetch, root, collection, key, value) {
    return fetch(`api/identity/${root}/private/kv/${collection}/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
    });
}

async function kvValues(fetch, root, collection) {
    const body = await (
        await fetch(`api/identity/${root}/private/kv/${collection}`)
    ).json();
    return body;
}

describe("private chains: the encrypted KV + set store", function () {
    this.timeout(30000);

    it("registers round-trip, LWW converges, ciphertext only in the log", async function () {
        const user = await makeUserFetch({ prefix: "privkv" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const secretValue = "Dave from the hat convention";
        await putKv(user, root, "contacts", "dave", "WRONG NAME");
        await putKv(user, root, "contacts", "dave", secretValue);

        const kv = await kvValues(user, root, "contacts");
        assert.equal(kv.values.length, 1);
        assert.equal(kv.values[0].key, "dave");
        assert.equal(kv.values[0].value, secretValue, "the later write wins");
        assert.equal(kv.undecryptable, 0);

        // The one that matters: the plaintext never touches the stored log. Every private
        // record is ciphertext under the epoch key.
        const entries = await (await user(`api/identity/${root}/entries`)).json();
        const privateEntries = entries.filter((e) => e.service === PRIVATE_SERVICE);
        assert.ok(privateEntries.length >= 2, "private records landed on the private chain");
        const plaintextHex = Buffer.from(secretValue, "utf8").toString("hex");
        for (const e of entries) {
            assert.ok(
                !e.bytes_hex.includes(plaintextHex),
                "stored entry bytes must never contain private plaintext"
            );
        }
    });

    it("sets add, remove, and re-add", async function () {
        const user = await makeUserFetch({ prefix: "privset" });
        const created = await (await user("api/identity", { method: "POST" })).json();
        const root = created.root_pubkey;

        const add = (element) =>
            user(`api/identity/${root}/private/set/follows`, {
                method: "POST",
                body: JSON.stringify({ element }),
            });
        const remove = (element) =>
            user(`api/identity/${root}/private/set/follows/${element}`, {
                method: "DELETE",
            });

        await add("alice");
        await add("bob");
        await remove("alice");
        await add("alice");

        const body = await (
            await user(`api/identity/${root}/private/set/follows`)
        ).json();
        const elements = body.elements.map((e) => e.element).sort();
        assert.deepEqual(elements, ["alice", "bob"], "re-add after remove sticks");
    });
});

(HOST_B ? describe : describe.skip)(
    "private chains across two nodes: adoption, sync, and the revocation boundary",
    function () {
        this.timeout(60000);

        it("carries private state through adoption, syncs it, and closes the future on revocation", async function () {
            // --- Act 1: identity on A, with one private contact written before B exists.
            const alice = await makeUserFetch({ prefix: "pcalice" });
            const created = await (await alice("api/identity", { method: "POST" })).json();
            const root = created.root_pubkey;
            await putKv(alice, root, "contacts", "dave", "Dave, met in person");

            // --- Act 2: adopt node B. The grant re-seals the epoch history to B's leaf; the
            // adoption's second sync (member-proven) pulls the private chains.
            const aliceOnB = await makeUserFetch({ prefix: "pcaliceb", host: HOST_B });
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
            await aliceOnB("api/identity/adopt/complete", {
                method: "POST",
                body: JSON.stringify({ code: grant.code }),
            });

            const kvOnB = await kvValues(aliceOnB, root, "contacts");
            assert.equal(kvOnB.values.length, 1, "B reads the pre-adoption private state");
            assert.equal(kvOnB.values[0].value, "Dave, met in person");
            assert.equal(kvOnB.undecryptable, 0, "B holds the full epoch history");

            // --- Act 3: a private write on B flows back to A over member-proven sync.
            await putKv(aliceOnB, root, "contacts", "eve", "Eve, vouched by Dave");
            const syncResults = await (
                await alice(`api/identity/${root}/sync`, { method: "POST" })
            ).json();
            assert.ok(syncResults.some((r) => r.ok), "A reached B");
            const kvOnA = await kvValues(alice, root, "contacts");
            assert.deepEqual(
                kvOnA.values.map((v) => v.key).sort(),
                ["dave", "eve"],
                "A sees B's private write"
            );

            // --- Act 4: revoke B. This appends the revocation AND rotates to a fresh epoch
            // sealed to everyone but B.
            await alice(`api/identity/${root}/keys/${leaf}/revoke`, {
                method: "POST",
                body: JSON.stringify({ disposition: "repudiation" }),
            });

            // A writes a post-rotation secret B must never learn.
            await putKv(alice, root, "contacts", "frank", "Frank, replaced B's server");

            // Push the news to B (the revocation and epoch entries are public; the new private
            // record is not, and B - now unproven at A's gate - must not receive it).
            await alice(`api/identity/${root}/sync`, { method: "POST" });

            // --- Act 5: the boundary, both sides of it.
            const kvOnA2 = await kvValues(alice, root, "contacts");
            assert.deepEqual(
                kvOnA2.values.map((v) => v.key).sort(),
                ["dave", "eve", "frank"],
                "A, still a member, reads everything"
            );

            const kvOnB2 = await kvValues(aliceOnB, root, "contacts");
            assert.deepEqual(
                kvOnB2.values.map((v) => v.key).sort(),
                ["dave", "eve"],
                "B keeps reading its era forever"
            );

            // Stronger than "can't decrypt": the post-rotation ciphertext never even reached B.
            const entriesB = await (await aliceOnB(`api/identity/${root}/entries`)).json();
            const privateOnB = entriesB.filter((e) => e.service === PRIVATE_SERVICE);
            const privateOnA = (await (await alice(`api/identity/${root}/entries`)).json())
                .filter((e) => e.service === PRIVATE_SERVICE);
            assert.equal(
                privateOnB.length,
                privateOnA.length - 1,
                "the post-revocation private record is withheld from B, not just unreadable"
            );
        });
    }
);
