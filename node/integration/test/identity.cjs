const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch, sql } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

async function createIdentity(fetch) {
    return fetch("api/identity", { method: "POST" });
}

describe("identity creation", function () {
    it("requires a session", async function () {
        const resp = await createIdentity(makeFetch());
        assert.equal(resp.status, 401);
    });

    it("creates an identity with a 64-hex-char root pubkey", async function () {
        const user = await makeUserFetch({ prefix: "idcreator" });
        const resp = await createIdentity(user);
        assert.equal(resp.status, 200);

        const body = await resp.json();
        // ed25519 public key is 32 bytes -> 64 hex chars.
        assert.match(body.root_pubkey, /^[0-9a-f]{64}$/, "root_pubkey should be 64 hex chars");
        assert.ok(body.created_at_ms > 0);
    });

    it("records the identity linked to its owner account", async function () {
        const user = await makeUserFetch({ prefix: "idowner" });
        const body = await (await createIdentity(user)).json();

        const { rows } = await sql(
            `SELECT account_id FROM identities WHERE root_pubkey = '${body.root_pubkey}'`
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].account_id, user.account.id);
    });

    it("produces a distinct keypair each time", async function () {
        const user = await makeUserFetch({ prefix: "idmulti" });
        const a = await (await createIdentity(user)).json();
        const b = await (await createIdentity(user)).json();
        assert.notEqual(a.root_pubkey, b.root_pubkey);
    });
});

describe("identity listing", function () {
    it("lists only the caller's identities", async function () {
        const alice = await makeUserFetch({ prefix: "alice" });
        const bob = await makeUserFetch({ prefix: "bob" });

        const a1 = await (await createIdentity(alice)).json();
        const a2 = await (await createIdentity(alice)).json();
        await createIdentity(bob); // bob has one, should not appear in alice's list

        const resp = await alice("api/identity");
        assert.equal(resp.status, 200);
        const list = await resp.json();

        const keys = list.map((i) => i.root_pubkey).sort();
        assert.deepEqual(keys, [a1.root_pubkey, a2.root_pubkey].sort());
    });

    it("returns an empty list for an account with no identities", async function () {
        const fresh = await makeUserFetch({ prefix: "empty" });
        const list = await (await fresh("api/identity")).json();
        assert.deepEqual(list, []);
    });
});
