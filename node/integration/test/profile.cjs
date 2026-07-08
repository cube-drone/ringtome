/*
    Profile chains: the first real consumer of the IM-AOL.

    Setting a profile field signs a profile-set entry onto the identity's profile chain; the
    profile endpoint reads the materialized view; rebuild wipes the view and replays the signed
    log. The last test here is the M1 exit demo: state survives the view being rebuilt from
    entries alone.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

async function makeIdentity(fetch) {
    const resp = await fetch("api/identity", { method: "POST" });
    assert.equal(resp.status, 200);
    return (await resp.json()).root_pubkey;
}

async function setField(fetch, root, field, value) {
    return fetch(`api/identity/${root}/profile`, {
        method: "POST",
        body: JSON.stringify({ field, value }),
    });
}

describe("profile chains", function () {
    it("sets and reads a profile field", async function () {
        const user = await makeUserFetch({ prefix: "profset" });
        const root = await makeIdentity(user);

        const resp = await setField(user, root, "name", "Hats Ahoy");
        assert.equal(resp.status, 200);
        const body = await resp.json();
        assert.equal(body.seq, 0, "first entry on the chain is seq 0");
        assert.match(body.entry_hash, /^[0-9a-f]{64}$/);

        const profile = await (await user(`api/identity/${root}/profile`)).json();
        assert.deepEqual(
            profile.map((f) => [f.field, f.value]),
            [["name", "Hats Ahoy"]]
        );
    });

    it("later writes win (the display-name rename)", async function () {
        const user = await makeUserFetch({ prefix: "profl" });
        const root = await makeIdentity(user);

        await setField(user, root, "name", "Hats Ahoy");
        const second = await (await setField(user, root, "name", "Hat Fan")).json();
        assert.equal(second.seq, 1, "same chain, next seq");

        const profile = await (await user(`api/identity/${root}/profile`)).json();
        assert.equal(profile.length, 1);
        assert.equal(profile[0].value, "Hat Fan");
    });

    it("rejects unknown fields and oversized values", async function () {
        const user = await makeUserFetch({ prefix: "profbad" });
        const root = await makeIdentity(user);

        const unknown = await setField(user, root, "hats_owned", "37");
        assert.equal(unknown.status, 400);

        const oversized = await setField(user, root, "bio", "x".repeat(5000));
        assert.equal(oversized.status, 400);
    });

    it("is invisible to accounts that don't own the identity", async function () {
        const alice = await makeUserFetch({ prefix: "profalice" });
        const mallory = await makeUserFetch({ prefix: "profmal" });
        const root = await makeIdentity(alice);

        // Uniform 404: not-yours is indistinguishable from nonexistent.
        assert.equal((await setField(mallory, root, "name", "gotcha")).status, 404);
        assert.equal((await mallory(`api/identity/${root}/profile`)).status, 404);
        assert.equal(
            (await mallory(`api/identity/${root}/entries`)).status,
            404
        );
        assert.equal(
            (await mallory(`api/identity/${root}/rebuild`, { method: "POST" })).status,
            404
        );
    });

    it("exposes the signed entry log, densely sequenced and hash-linked", async function () {
        const user = await makeUserFetch({ prefix: "proflog" });
        const root = await makeIdentity(user);

        await setField(user, root, "name", "a");
        await setField(user, root, "bio", "b");
        await setField(user, root, "name", "c");

        const entries = await (await user(`api/identity/${root}/entries`)).json();
        // 5 entries: the identity chain's genesis (recovery-key authorization) and epoch-0
        // key-epoch (both service 0) plus the three profile-sets (service 2).
        assert.equal(entries.length, 5);
        const profileEntries = entries.filter((e) => e.service === 2);
        assert.deepEqual(
            profileEntries.map((e) => e.seq),
            [0, 1, 2],
            "dense sequence numbers per chain"
        );
        assert.equal(
            entries.filter((e) => e.service === 0).length,
            2,
            "identity genesis + epoch 0 present"
        );
        for (const e of entries) {
            assert.match(e.bytes_hex, /^[0-9a-f]+$/);
            assert.match(e.hash_hex, /^[0-9a-f]{64}$/);
        }
    });

    // The M1 exit demo: the materialized view is a disposable cache of the signed log.
    it("rebuilds an identical profile from the entries log alone", async function () {
        const user = await makeUserFetch({ prefix: "profreb" });
        const root = await makeIdentity(user);

        await setField(user, root, "name", "Hats Ahoy");
        await setField(user, root, "bio", "purveyor of fine hats");
        await setField(user, root, "name", "Hat Fan");

        const before = await (await user(`api/identity/${root}/profile`)).json();

        const rebuild = await (
            await user(`api/identity/${root}/rebuild`, { method: "POST" })
        ).json();
        // 3 profile-sets + the identity chain's genesis authorize + epoch 0 = 5 replayed and
        // re-validated.
        assert.equal(rebuild.entries_replayed, 5, "every signed entry replays and re-validates");

        const after = await (await user(`api/identity/${root}/profile`)).json();
        assert.deepEqual(after, before, "replaying the log reproduces the exact same view");
        assert.equal(after.find((f) => f.field === "name").value, "Hat Fan");
    });
});
