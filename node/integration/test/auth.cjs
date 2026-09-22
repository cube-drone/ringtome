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

    it("allows short PINs on a loopback node, rejects only empty", async function () {
        // The integration node binds 127.0.0.1, so the password floor relaxes to a PIN:
        // reaching this login prompt already required being at the machine
        // (Config::password_min_len - a public bind keeps the 8-character floor, which the
        // Rust unit test covers since this harness has no network-facing node).
        const fetch = makeFetch();
        const pin = await register(fetch, uniqueUsername(), "1234");
        assert.equal(pin.status, 200, "a PIN is an honest posture on a local device");
        const empty = await register(fetch, uniqueUsername(), "");
        assert.equal(empty.status, 400, "empty is confusion, not a posture");
    });

    /*
        A cross-site caller is nobody here (DESKTOP.md, Stage 3). `SameSite=Lax` keeps the
        session cookie off a cross-site `fetch`, but it deliberately SENDS it on a cross-site
        top-level GET navigation - which a page on the open web can perform on itself, at a
        door of its choosing, and bounce back from. Two of this node's GET doors have side
        effects (a foreign profile fetch dials the endpoints its query names; entering a room
        joins it), so the browser's own label is read and the session ignored. Anonymous, not
        refused: the public surfaces still answer, because a stranger arriving from another
        site is exactly an anonymous caller.
    */
    it("treats a cross-site request as anonymous, and keeps the public doors open to it", async function () {
        const fetch = makeFetch();
        const username = uniqueUsername();
        const password = "correct horse battery staple";
        assert.equal((await register(fetch, username, password)).status, 200);
        assert.equal((await login(fetch, username, password)).status, 200);

        const whoami = await fetch("api/auth/whoami");
        assert.equal(whoami.status, 200, "the cookie works, as it always has");

        const crossSite = await fetch("api/auth/whoami", { headers: { "Sec-Fetch-Site": "cross-site" } });
        assert.equal(crossSite.status, 401, "the same cookie, labelled cross-site, is nobody");

        const sameOrigin = await fetch("api/auth/whoami", { headers: { "Sec-Fetch-Site": "same-origin" } });
        assert.equal(sameOrigin.status, 200, "our own page is unaffected");

        const publicDoor = await fetch("api/node/personas", { headers: { "Sec-Fetch-Site": "cross-site" } });
        assert.equal(publicDoor.status, 200, "and a public door answers anonymously rather than erroring");
    });
});
