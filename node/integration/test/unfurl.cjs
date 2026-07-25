/*
    The turbolink unfurl endpoint (net::unfurl): the node fetches foreign pages' OpenGraph
    cards on the browser's behalf. What integration can prove WITHOUT touching the real
    internet is exactly the safety envelope: the session gate, the SSRF guard (loopback and
    private names refused - which we can exercise with real DNS against real local
    addresses), and the global rate limit (refusals spend the same budget, so the 429 is
    reachable offline). The happy-path parse is pinned by Rust unit tests on fixtures.
*/
const assert = require("node:assert");
const { makeFetch } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

describe("unfurl", () => {
    let user;
    before(async () => {
        user = await makeUserFetch({ prefix: "unfurl" });
    });

    it("requires a session - unfurling spends the node's outbound budget", async () => {
        const anon = makeFetch();
        const resp = await anon(`api/unfurl?url=${encodeURIComponent("https://example.com/")}`);
        assert.equal(resp.status, 401);
    });

    it("refuses non-web schemes", async () => {
        const resp = await user(`api/unfurl?url=${encodeURIComponent("file:///etc/passwd")}`);
        assert.equal(resp.status, 400);
    });

    it("refuses to be a periscope into its own network", async () => {
        // Loopback by literal, loopback by name, and a private range: the SSRF guard
        // resolves and vets every one before any connection is made.
        for (const target of [
            "http://127.0.0.1:8080/",
            "http://localhost/",
            "http://192.168.1.1/",
            "http://[::1]/",
        ]) {
            const resp = await user(`api/unfurl?url=${encodeURIComponent(target)}`);
            assert.equal(resp.status, 400, `${target} must be refused`);
            const body = await resp.json();
            assert.match(body.message, /not public|does not resolve/i);
        }
    });

    it("meters the global outbound budget generously but really", async function () {
        this.timeout(30000);
        // Refused targets spend tokens too (the budget sits in front of the guard), which
        // makes the limit provable offline: hammer refusals until 429 appears.
        let limited = false;
        for (let i = 0; i < 40 && !limited; i++) {
            const resp = await user(
                `api/unfurl?url=${encodeURIComponent(`http://192.168.0.${i + 1}/`)}`
            );
            if (resp.status === 429) limited = true;
            else assert.equal(resp.status, 400);
        }
        assert.ok(limited, "a sustained hammer must eventually see 429");
    });
});
