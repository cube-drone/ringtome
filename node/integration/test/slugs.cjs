/*
    Node slugs (UNAUTHED.md, rulings 6 and 7, 2026-09-16): a short address a hosted persona
    claims on this node - first come first served, meaning nothing on any other node. Ada
    claims one; bea cannot take it; the grammar is enforced; ada changes it and keeps the
    old one, which redirects and which bea still cannot take; ada retakes her old one (the
    swap); a third change frees the oldest; /@slug serves the persona page with her name in
    the head; the people door and the profile name the slug; nobody else can flip hers.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { makeFetch } = require("./fetch.cjs");

const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

describe("node slugs: a short name on this node", function () {
    this.timeout(120000);

    let ada, adaRoot, bea, beaRoot, stranger;
    const stamp = Date.now().toString(36).slice(-5);
    const cube = `cube-${stamp}`;
    const drone = `drone-${stamp}`;
    const third = `third-${stamp}`;

    before(async () => {
        ada = await makeUserFetch({ prefix: "slugada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await j(ada, `api/identity/${adaRoot}/profile`, { field: "name", value: "Ada Slug" });
        bea = await makeUserFetch({ prefix: "slugbea" });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        stranger = makeFetch();
    });

    it("first come, first served; the grammar is enforced", async () => {
        const r = await j(ada, `api/identity/${adaRoot}/slug`, { slug: `@${cube.toUpperCase()}` }, "PUT");
        assert.equal(r.status, 200, await r.clone().text());
        assert.equal((await r.json()).slug, cube, "lowered, the @ forgiven");
        const taken = await j(bea, `api/identity/${beaRoot}/slug`, { slug: cube }, "PUT");
        assert.notEqual(taken.status, 200);
        assert.match(await taken.text(), /already has that name/);
        for (const bad of ["ab", "-abc", "abc-", "a b", "x".repeat(33)]) {
            const no = await j(ada, `api/identity/${adaRoot}/slug`, { slug: bad }, "PUT");
            assert.notEqual(no.status, 200, bad);
        }
        assert.notEqual((await j(bea, `api/identity/${adaRoot}/slug`, { slug: drone }, "PUT")).status, 200, "nobody else can set hers");
    });

    it("/@slug is her page, with her name in the head; the people door and the profile name it", async () => {
        const r = await stranger(`@${cube}`);
        assert.equal(r.status, 200);
        const body = await r.text();
        assert.ok(body.includes("<title>Ada Slug</title>"), "the head carries her name");
        assert.ok(body.includes("app.js"), "the app takes the body");
        const who = await (await stranger(`api/node/slugs/${cube}`)).json();
        assert.equal(who.root, adaRoot);
        assert.equal(who.current, true);
        const people = (await (await stranger("api/node/personas")).json()).people || [];
        assert.equal((people.find((p) => p.root === adaRoot) || {}).slug, cube);
        const prof = await (await stranger(`api/id/${adaRoot}/profile`)).json();
        assert.equal(prof.slug, cube);
        assert.equal((await stranger(`@nobody-${stamp}`)).status, 404, "an unknown name is a 404");
    });

    it("a change keeps the old name, which redirects and which nobody else may take; retaking it swaps", async () => {
        const r = await (await j(ada, `api/identity/${adaRoot}/slug`, { slug: drone }, "PUT")).json();
        assert.deepEqual([r.slug, r.last], [drone, cube]);
        const old = await stranger(`@${cube}`, { redirect: "manual" });
        assert.ok([301, 302, 307, 308].includes(old.status), `the old name redirects: ${old.status}`);
        assert.equal(old.headers.get("location"), `/@${drone}`);
        assert.notEqual((await j(bea, `api/identity/${beaRoot}/slug`, { slug: cube }, "PUT")).status, 200, "the old name is still hers");
        const back = await (await j(ada, `api/identity/${adaRoot}/slug`, { slug: cube }, "PUT")).json();
        assert.deepEqual([back.slug, back.last], [cube, drone], "the swap");
    });

    it("a third change drops the oldest, which is free again; giving a name up keeps it as the last", async () => {
        const r = await (await j(ada, `api/identity/${adaRoot}/slug`, { slug: third }, "PUT")).json();
        assert.deepEqual([r.slug, r.last], [third, cube]);
        assert.equal((await j(bea, `api/identity/${beaRoot}/slug`, { slug: drone }, "PUT")).status, 200, "the dropped name is free");
        const gone = await (await j(ada, `api/identity/${adaRoot}/slug`, { slug: "" }, "PUT")).json();
        assert.deepEqual([gone.slug, gone.last], [null, third]);
        const people = (await (await stranger("api/node/personas")).json()).people || [];
        assert.equal((people.find((p) => p.root === adaRoot) || {}).slug, null, "no current name on the people page");
    });
});
