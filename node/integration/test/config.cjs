const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeFetch } = require("./fetch.cjs");

describe("public config", function () {
    it("exposes only the public subset of config", async function () {
        const fetch = makeFetch();
        const resp = await fetch("api/config");

        assert.equal(resp.status, 200);

        const body = await resp.json();
        assert.ok(body.app_version, "expected app_version");
        assert.ok(["dev", "prod"].includes(body.environment), "expected environment dev|prod");

        // The public config must not leak internal fields (bind address, data directory, etc.).
        assert.equal(body.bind_address, undefined);
        assert.equal(body.data_directory, undefined);
        assert.equal(body.port, undefined);
    });
});

describe("unknown routes", function () {
    it("returns 404 for an unknown path", async function () {
        const fetch = makeFetch();
        const resp = await fetch("this-route-does-not-exist");
        assert.equal(resp.status, 404);
    });
});
