const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

describe("makeUserFetch fixture", function () {
    it("returns an already-authenticated fetch", async function () {
        const user = await makeUserFetch();

        const resp = await user("api/auth/whoami");
        assert.equal(resp.status, 200, "fixture user should be logged in");

        const body = await resp.json();
        assert.equal(body.username, user.username);
        assert.equal(body.id, user.account.id);
    });

    it("produces independent, isolated sessions per user", async function () {
        const alice = await makeUserFetch({ prefix: "alice" });
        const bob = await makeUserFetch({ prefix: "bob" });

        assert.notEqual(alice.username, bob.username);

        // Each sees itself, not the other - separate cookie jars, separate sessions.
        const aliceWho = await (await alice("api/auth/whoami")).json();
        const bobWho = await (await bob("api/auth/whoami")).json();
        assert.equal(aliceWho.username, alice.username);
        assert.equal(bobWho.username, bob.username);
        assert.notEqual(aliceWho.id, bobWho.id);
    });

    it("honors an explicit username override", async function () {
        const { uniqueUsername } = require("./helpers.cjs");
        const name = uniqueUsername("custom");
        const user = await makeUserFetch({ username: name });
        assert.equal(user.username, name);

        const who = await (await user("api/auth/whoami")).json();
        assert.equal(who.username, name);
    });
});
