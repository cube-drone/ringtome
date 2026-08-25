/*
    The directory (GET /api/directory): the personas this node KNOWS, for its members - the
    first surface anywhere that ENUMERATES identities, which is why every assertion here is a
    consent line rather than a feature check.
*/
const assert = require("node:assert");
const { makeFetch, HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");


describe("the directory", () => {
    let member, dark, darkRoot, served, servedRoot;

    before(async () => {
        member = await makeUserFetch({ prefix: "dirmember" });
        await (await member("api/identity", { method: "POST" })).json();

        dark = await makeUserFetch({ prefix: "dirdark" });
        darkRoot = (await (await dark("api/identity", { method: "POST" })).json()).root_pubkey;
        await dark(`api/identity/${darkRoot}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Nobody Should See Me" }),
        });

        served = await makeUserFetch({ prefix: "dirserved" });
        servedRoot = (await (await served("api/identity", { method: "POST" })).json())
            .root_pubkey;
        await served(`api/identity/${servedRoot}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Proudly Listed" }),
        });
        const pub = await served(`api/identity/${servedRoot}/serve`, { method: "POST" });
        assert.equal(pub.status, 200, await pub.text());
    });

    it("gives a stranger nothing - members' acquaintances are not a public list", async () => {
        const anon = makeFetch();
        const resp = await anon("api/directory");
        assert.ok(resp.status === 401 || resp.status === 403, `got ${resp.status}`);
    });

    it("lists a SERVED persona, wearing its cached byline", async () => {
        await beat(undefined, "fold", servedRoot);
        const list = await (await member("api/directory")).json();
        const row = list.find((r) => r.root === servedRoot && r.name === "Proudly Listed");
        assert.ok(row, "serving is the consent that lists you");
        assert.equal(row.hosted, true);
        assert.match(row.speakable, /^[a-z]+-[a-z]+-/, "with the address a human can carry");
    });

    it("keeps a DARK persona dark - born unlisted, stays unlisted until the serve act", async () => {
        // The dark persona has a name and a heartbeat; only consent is missing.
        const list = await (await member("api/directory")).json();
        assert.ok(
            !list.some((r) => r.root === darkRoot),
            "a persona that never chose publication is not volunteered to housemates"
        );
    });
});

(HOST_B ? describe : describe.skip)("the directory, across nodes", function () {
    this.timeout(60000);

    it("lists a persona a member merely REACHED, as known-not-hosted", async function () {
        const far = await makeUserFetch({ prefix: "dirfar", host: HOST_B });
        const farRoot = (await (await far("api/identity", { method: "POST" })).json()).root_pubkey;
        await far(`api/identity/${farRoot}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Distant Friend" }),
        });
        const { toBase58 } = await import("../../js/speakable.js");
        const viaB = toBase58((await (await far("api/node")).json()).endpoint_id);

        const local = await makeUserFetch({ prefix: "dirlocal" });
        await (await local("api/identity", { method: "POST" })).json();
        const visit = await local(`api/id/${farRoot}/profile?via=${viaB}`);
        assert.equal(visit.status, 200, await visit.text());

        await beat(undefined, "fold", farRoot);
        const list = await (await local("api/directory")).json();
        const row = list.find((r) => r.root === farRoot);
        assert.ok(row, "someone here met them, so the node knows them");
        assert.equal(row.hosted, false, "known around here, not living here");
        assert.equal(row.name, "Distant Friend", "byline from the cache, no db per face");
    });
});
