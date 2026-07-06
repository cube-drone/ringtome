const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch } = require("./fetch.cjs");

// Unique username per run so repeated test runs against a persistent node don't collide.
function uniqueUsername() {
    return "user_" + Math.random().toString(36).slice(2, 10);
}

async function register(fetch, username, password) {
    return fetch("api/auth/register", {
        method: "POST",
        body: JSON.stringify({ username, password }),
    });
}

async function login(fetch, username, password) {
    return fetch("api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
    });
}

describe("auth", function () {
    it("registers, logs in, identifies, and logs out", async function () {
        const fetch = makeFetch(); // fresh cookie jar
        const username = uniqueUsername();
        const password = "correct horse battery staple";

        // Register.
        let resp = await register(fetch, username, password);
        assert.equal(resp.status, 200, "register should succeed");
        let body = await resp.json();
        assert.equal(body.username, username);

        // Before login, whoami is unauthorized.
        resp = await fetch("api/auth/whoami");
        assert.equal(resp.status, 401, "whoami should be 401 before login");

        // Log in (sets the session cookie in the jar).
        resp = await login(fetch, username, password);
        assert.equal(resp.status, 200, "login should succeed");

        // whoami now works and returns the right account.
        resp = await fetch("api/auth/whoami");
        assert.equal(resp.status, 200, "whoami should be 200 after login");
        body = await resp.json();
        assert.equal(body.username, username);

        // Log out.
        resp = await fetch("api/auth/logout", { method: "POST" });
        assert.equal(resp.status, 200, "logout should succeed");

        // whoami is unauthorized again (session revoked server-side).
        resp = await fetch("api/auth/whoami");
        assert.equal(resp.status, 401, "whoami should be 401 after logout");
    });

    it("rejects wrong passwords and duplicate usernames", async function () {
        const fetch = makeFetch();
        const username = uniqueUsername();
        const password = "a-good-password";

        assert.equal((await register(fetch, username, password)).status, 200);

        // Duplicate username.
        const dup = await register(fetch, username, "another-password");
        assert.equal(dup.status, 400, "duplicate username should be rejected");

        // Wrong password.
        const bad = await login(fetch, username, "wrong-password");
        assert.equal(bad.status, 401, "wrong password should be 401");

        // Nonexistent user (same 401 - no user enumeration).
        const missing = await login(fetch, uniqueUsername(), "whatever");
        assert.equal(missing.status, 401, "nonexistent user should be 401");
    });

    it("rejects short passwords at registration", async function () {
        const fetch = makeFetch();
        const resp = await register(fetch, uniqueUsername(), "short");
        assert.equal(resp.status, 400);
    });
});
