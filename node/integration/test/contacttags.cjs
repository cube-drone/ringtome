/*
    Contact tags (PROJECT_PLAN's Contact tags, 2026-09-10): private labels on the people you
    know, one register in the contact's bag on the private chain - written through the same
    door as trust and nickname, read back with the bag, never on any public chain.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

describe("contact tags: private labels on the people you know", function () {
    this.timeout(120000);

    let ada, adaRoot, bea, beaRoot;

    before(async () => {
        ada = await makeUserFetch({ prefix: "ctagada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        bea = await makeUserFetch({ prefix: "ctagbea" });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
    });

    it("the tags register rides the contact's bag beside trust and nickname, and clears to nothing", async () => {
        const bag = `contact:${beaRoot}`;
        assert.equal((await j(ada, `api/identity/${adaRoot}/private/kv/${encodeURIComponent(bag)}/trust`, { value: "high" }, "PUT")).status, 200);
        assert.equal((await j(ada, `api/identity/${adaRoot}/private/kv/${encodeURIComponent(bag)}/tags`, { value: '["family","bikes"]' }, "PUT")).status, 200);
        const values = (await (await ada(`api/identity/${adaRoot}/private/kv/${encodeURIComponent(bag)}`)).json()).values || [];
        const by = Object.fromEntries(values.map((v) => [v.key, v.value]));
        assert.equal(by.trust, "high");
        assert.equal(by.tags, '["family","bikes"]', "the register holds the list as written");
        assert.equal((await j(ada, `api/identity/${adaRoot}/private/kv/${encodeURIComponent(bag)}/tags`, { value: "" }, "PUT")).status, 200);
        const after = (await (await ada(`api/identity/${adaRoot}/private/kv/${encodeURIComponent(bag)}`)).json()).values || [];
        assert.equal((after.find((v) => v.key === "tags") || {}).value || "", "", "cleared");
    });

    it("nothing about a contact tag reaches the public chains", async () => {
        const bag = `contact:${beaRoot}`;
        await j(ada, `api/identity/${adaRoot}/private/kv/${encodeURIComponent(bag)}/tags`, { value: '["family"]' }, "PUT");
        const profile = await (await bea(`api/id/${adaRoot}/profile`)).json();
        assert.ok(!JSON.stringify(profile).includes("family"), "the profile a stranger reads carries no tag");
        const shelf = await (await bea(`api/id/${adaRoot}/posts`)).text();
        assert.ok(!shelf.includes("family"), "nor the shelf");
    });
});
