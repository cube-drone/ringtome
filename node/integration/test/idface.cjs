/*
    The /id surface (src/idface.rs): one URL, two audiences.

    Anonymous gets the server-rendered face in its three v1 shapes - the shelf (a hosted
    persona's public profile), the warm tombstone (a root nobody here carries), and the
    checksum refusal (worded address whose words lie). A session gets the SPA shell instead.
    The /api/id JSON face follows the same shelf rule, anonymously.
*/
const assert = require("node:assert");
const { makeFetch } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

// The anonymous fetch: no cookie jar entries, just a stranger with a URL.
const anon = makeFetch();

let owner, root, speakableAddr;

before(async () => {
    owner = await makeUserFetch({ prefix: "idface" });
    const made = await (await owner("api/identity", { method: "POST" })).json();
    root = made.root_pubkey;
    await owner(`api/identity/${root}/profile`, {
        method: "POST",
        body: JSON.stringify({ field: "name", value: "Idface Test Persona" }),
    });
    await owner(`api/identity/${root}/profile`, {
        method: "POST",
        body: JSON.stringify({ field: "bio", value: "a persona <with> markup & edges" }),
    });
    const prof = await (await anon(`api/id/${root}/profile`)).json();
    speakableAddr = prof.speakable;
});

describe("the /id face", () => {
    it("serves a hosted persona's public face to a stranger (the shelf)", async () => {
        const resp = await anon(`id/${root}`); // the hex escape hatch
        assert.equal(resp.status, 200);
        assert.equal(resp.headers.get("x-content-type-options"), "nosniff");
        assert.match(resp.headers.get("content-security-policy"), /default-src 'none'/);
        const body = await resp.text();
        assert.ok(body.includes("Idface Test Persona"), "profile name renders");
        assert.ok(
            body.includes("&lt;with&gt; markup &amp; edges"),
            "profile text is escaped, never trusted"
        );
        assert.ok(!body.includes("app.js"), "the face is static HTML, not the SPA");
        assert.ok(body.includes("?via="), "the address is the full shareable form, hints and all");
        assert.ok(
            body.indexOf("?via=") < body.indexOf("&lt;with&gt;"),
            "the address sits above the bio"
        );
    });

    it("serves the same face at the speakable spelling, words verified", async () => {
        const resp = await anon(`id/${speakableAddr}`);
        assert.equal(resp.status, 200);
        const body = await resp.text();
        assert.ok(body.includes("Idface Test Persona"));
    });

    it("REFUSES lying words, loudly, with the truth in hand", async () => {
        const key = speakableAddr.split("-")[2];
        const trueWords = speakableAddr.split("-").slice(0, 2).join("-");
        const resp = await anon(`id/pagoda-dimension-${key}`);
        assert.equal(resp.status, 400);
        const body = await resp.text();
        assert.ok(body.includes("mangled"), "the refusal says what happened");
        assert.ok(body.includes(trueWords), '"did you mean" carries the true words');
    });

    it("tombstones a root nobody here carries - warmly, 404", async () => {
        const stranger = "ee".repeat(32);
        const resp = await anon(`id/${stranger}`);
        assert.equal(resp.status, 404);
        const body = await resp.text();
        assert.ok(body.includes("quiet side"), "the tombstone is warm, not blank");
        assert.ok(body.includes("/id/"), "it hands over the re-homeable address");
    });

    it("hands a SESSION the SPA shell instead - the lens is the console's job", async () => {
        const resp = await owner(`id/${root}`);
        assert.equal(resp.status, 200);
        const body = await resp.text();
        assert.ok(body.includes("app.js"), "the SPA boots at /id for members");
    });

    it("404s garbage that is not an address in any spelling", async () => {
        const resp = await anon("id/not-an-address-at-all-really");
        assert.equal(resp.status, 404);
    });

    it("the JSON face follows the same shelf rule, anonymously", async () => {
        const prof = await (await anon(`api/id/${root}/profile`)).json();
        assert.equal(prof.root, root);
        assert.ok(prof.speakable.endsWith(prof.speakable.split("-")[2]));
        assert.ok(prof.fields.some((f) => f.field === "name" && f.value === "Idface Test Persona"));

        const missing = await anon(`api/id/${"ee".repeat(32)}/profile`);
        assert.equal(missing.status, 404);
    });
});
