/*
    API keys (auth/keys.rs; Curtis, 2026-09-30: "tokens that I can use to authenticate external
    clients as me when connecting to this node"). A key is made from a signed-in browser and shown
    once; an outside program sends it as `Authorization: Bearer rtk_...` and is that account - but it
    may not manage keys, nor administer the server, whatever the account's tags. The node keeps only
    the key's hash, and a revoked key stops at once.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { HOST, makeFetch, sql } = require("./fetch.cjs");

const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

describe("API keys: an outside program, as you", function () {
    this.timeout(120000);

    let me, root, key, keyId;
    // A program with no cookie at all - only the key.
    const program = (k) => {
        const bare = makeFetch();
        return (path, opts = {}) => bare(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${k}` } });
    };

    before(async () => {
        me = await makeUserFetch({ prefix: "keyuser" });
        // An administrator, so the claim can show a key never carries that.
        await sql(`INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${me.account.id}', 'node_admin')`, HOST);
        root = (await (await me("api/identity", { method: "POST" })).json()).root_pubkey;
    });

    it("is made from the browser and shown once, and the node keeps only its hash", async () => {
        const made = await j(me, "api/auth/keys", { name: "my backup script" });
        assert.equal(made.status, 200, await made.clone().text());
        ({ key, id: keyId } = await made.json());
        assert.match(key, /^rtk_[0-9a-f]{64}$/);

        const listed = (await (await me("api/auth/keys")).json()).keys;
        assert.equal(listed.length, 1);
        assert.equal(listed[0].name, "my backup script");
        assert.equal(listed[0].key, undefined, "the listing never shows the key");

        const { rows } = await sql(`SELECT key_hash FROM api_keys WHERE id = '${keyId}'`, HOST);
        assert.equal(rows.length, 1);
        assert.notEqual(rows[0].key_hash, key, "a hash, not the key");
        assert.ok(!JSON.stringify(rows).includes(key.slice(4)), "the key's secret is nowhere in the row");
        assert.equal((await j(me, "api/auth/keys", { name: "  " })).status, 400, "a key needs a name");
    });

    it("signs a program in as the account: who it is, its personas, a note written", async () => {
        const prog = program(key);
        const who = await (await prog("api/auth/whoami")).json();
        assert.equal(who.username, me.account.username);
        const personas = await (await prog("api/identity")).json();
        assert.ok(JSON.stringify(personas).includes(root), "the account's personas");
        const doc = await j(prog, `api/identity/${root}/docs`, { title: "from a script", body: "hello", format: "marquee" });
        assert.equal(doc.status, 200, await doc.clone().text());
        const listed = (await (await me("api/auth/keys")).json()).keys;
        assert.ok(listed[0].last_used_ms, "and the key says when it was last used");
    });

    it("may not manage keys, nor administer the server, even an administrator's", async () => {
        const prog = program(key);
        assert.equal((await prog("api/auth/keys")).status, 403, "no listing keys with a key");
        assert.equal((await j(prog, "api/auth/keys", { name: "another" })).status, 403, "no making one");
        assert.equal((await prog(`api/auth/keys/${keyId}`, { method: "DELETE" })).status, 403, "no revoking");
        assert.equal((await me("api/admin/registration")).status, 200, "the browser administers");
        assert.equal((await prog("api/admin/registration")).status, 403, "the key does not");
    });

    it("refuses a key it doesn't know, and stops one revoked", async () => {
        assert.equal((await program(`rtk_${"0".repeat(64)}`)("api/auth/whoami")).status, 401);
        assert.equal((await me(`api/auth/keys/${keyId}`, { method: "DELETE" })).status, 200);
        assert.equal((await program(key)("api/auth/whoami")).status, 401, "revoked: at once");
        assert.equal(((await (await me("api/auth/keys")).json()).keys || []).length, 0);
    });
});
