const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch } = require("./fetch.cjs");

describe("health", function () {
    it("returns 200 with a JSON body reporting status ok", async function () {
        const fetch = makeFetch();
        const resp = await fetch("health");

        assert.equal(resp.status, 200);
        assert.match(resp.headers.get("content-type") || "", /application\/json/);

        const body = await resp.json();
        assert.equal(body.status, "ok");
        assert.ok(body.version, "expected a version string");
    });
});
