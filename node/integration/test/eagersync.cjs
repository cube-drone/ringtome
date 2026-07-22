/*
    Eager push: writes propagate between an identity's nodes with NO manual sync call.

    The harness runs both nodes with a fast debounce (RINGTOME_SYNC_DEBOUNCE_MS=250 in the
    justfile) but the anti-entropy interval at its 5-minute default - so anything these tests
    observe inside their 30s polling windows is provably the eager-push path, not the periodic
    resync masking it.

    Skips itself when the harness only booted one node (RINGTOME_TEST_HOST_B unset).
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

/* Write a profile field and insist the node accepted it - a rejected write would otherwise
   surface as a mystifying propagation timeout. ("bio" is one of the whitelisted fields.) */
async function setField(fetch, root, field, value) {
    const resp = await fetch(`api/identity/${root}/profile`, {
        method: "POST",
        body: JSON.stringify({ field, value }),
    });
    assert.equal(resp.status, 200, `profile write refused: ${await resp.text()}`);
    return resp;
}

async function profileValue(fetch, root, field) {
    const profile = await (await fetch(`api/identity/${root}/profile`)).json();
    const row = profile.find((f) => f.field === field);
    return row ? row.value : undefined;
}

async function kvValue(fetch, root, collection, key) {
    const body = await (
        await fetch(`api/identity/${root}/private/kv/${collection}`)
    ).json();
    const row = (body.values || []).find((v) => v.key === key);
    return row ? row.value : undefined;
}

/* Poll until `read` returns `expected`, failing with the last seen value on timeout. */
async function eventually(read, expected, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
        last = await read();
        if (last === expected) return;
        if (Date.now() > deadline) {
            assert.equal(last, expected, `${label}: not observed within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}

(HOST_B ? describe : describe.skip)("eager push: unprompted propagation", function () {
    // Two real nodes, real iroh, debounce windows: give the acts room.
    this.timeout(90000);

    let alice; // on node A
    let aliceOnB; // on node B
    let root;

    before(async function () {
        this.timeout(60000);
        // Standard adoption ceremony (the twonode.cjs pattern) to build the two-node identity.
        alice = await makeUserFetch({ prefix: "eager" });
        const created = await (await alice("api/identity", { method: "POST" })).json();
        root = created.root_pubkey;

        aliceOnB = await makeUserFetch({ prefix: "eagerb", host: HOST_B });
        const request = await (
            await aliceOnB("api/identity/adopt/begin", { method: "POST" })
        ).json();
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
        assert.equal(adopted.root_pubkey, root, "B agents the identity");
    });

    it("public and private writes on A surface on B unprompted", async function () {
        await setField(alice, root, "bio", "never call /sync");
        await alice(`api/identity/${root}/private/kv/contacts/edna`, {
            method: "PUT",
            body: JSON.stringify({ value: "hat enthusiast" }),
        });

        await eventually(
            () => profileValue(aliceOnB, root, "bio"),
            "never call /sync",
            "public write A->B"
        );
        await eventually(
            () => kvValue(aliceOnB, root, "contacts", "edna"),
            "hat enthusiast",
            "private write A->B"
        );
    });

    it("the mesh is symmetric: a write on B reaches A unprompted", async function () {
        await setField(aliceOnB, root, "bio", "written on B");
        await eventually(
            () => profileValue(alice, root, "bio"),
            "written on B",
            "public write B->A"
        );
    });
});
