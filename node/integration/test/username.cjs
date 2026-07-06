const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch } = require("./fetch.cjs");
const { makeUserFetch, uniqueUsername } = require("./helpers.cjs");

async function register(fetch, username, password = "test-password-123") {
    return fetch("api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password }),
    });
}

async function checkUsername(fetch, username) {
    return fetch(`api/auth/check-username?username=${encodeURIComponent(username)}`);
}

describe("username slug rules", function () {
    const invalid = [
        ["with spaces", "spaces not allowed"],
        ["Has-Caps", "uppercase (should normalize but stays a valid slug once lowercased)"],
        ["-leading", "leading separator"],
        ["trailing-", "trailing separator"],
        ["double__underscore", "consecutive separators"],
        ["bad!char", "punctuation"],
        ["a", "too short"],
    ];

    // "Has-Caps" is actually VALID once lowercased to "has-caps"; pull it out of the reject list.
    const rejectCases = invalid.filter(([n]) => n !== "Has-Caps");

    rejectCases.forEach(([name, why]) => {
        it(`rejects "${name}" (${why})`, async function () {
            const fetch = makeFetch();
            const resp = await register(fetch, name);
            assert.equal(resp.status, 400, `expected 400 for "${name}"`);
        });
    });

    it("normalizes uppercase to a lowercase slug", async function () {
        const fetch = makeFetch();
        const base = uniqueUsername("caps").toUpperCase(); // e.g. CAPS_XXX_1
        const resp = await register(fetch, base);
        assert.equal(resp.status, 200, "uppercase should be accepted and normalized");
        const body = await resp.json();
        assert.equal(body.username, base.toLowerCase(), "stored username should be lowercased");
    });

    it("treats case-variant usernames as the same account", async function () {
        const fetch = makeFetch();
        const name = uniqueUsername("dup");
        assert.equal((await register(fetch, name)).status, 200);
        // Registering the uppercase variant should collide (already taken).
        const dup = await register(makeFetch(), name.toUpperCase());
        assert.equal(dup.status, 400, "case-variant should be treated as taken");
    });
});

describe("check-username endpoint", function () {
    it("reports an unused name as available", async function () {
        const fetch = makeFetch();
        const resp = await checkUsername(fetch, uniqueUsername("free"));
        assert.equal(resp.status, 200);
        assert.equal((await resp.json()).available, true);
    });

    it("reports a taken name as unavailable", async function () {
        const user = await makeUserFetch({ prefix: "taken" });
        const resp = await checkUsername(makeFetch(), user.username);
        assert.equal(resp.status, 200);
        assert.equal((await resp.json()).available, false);
    });

    it("returns 400 for an invalid slug", async function () {
        const resp = await checkUsername(makeFetch(), "not a slug!");
        assert.equal(resp.status, 400);
    });
});
