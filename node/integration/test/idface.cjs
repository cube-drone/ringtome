/*
    The /id surface (src/idface.rs): one URL, two audiences.

    Anonymous gets the server-rendered face in its three v1 shapes - the shelf (a hosted
    persona's public profile), the warm tombstone (a root nobody here carries), and the
    checksum refusal (worded address whose words lie). A session gets the SPA shell instead.
    The /api/id JSON face follows the same shelf rule, anonymously.
*/
const assert = require("node:assert");
const { makeFetch, sql } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");

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

    it("draws the identicon for a persona with no picture - inline, no CSP loosening", async () => {
        const body = await (await anon(`id/${root}`)).text();
        assert.ok(body.includes("<svg"), "the identicon is inlined into the face");
        assert.ok(body.includes('viewBox="0 0 5 5"'), "the twinned identicon, not some other art");
        // The console draws this exact string from the same bytes (pure/identicon.js and
        // src/identicon.rs share goldens) - one persona, one face, everywhere.
        const { identiconSvg } = await import("../../js/pure/identicon.js");
        assert.ok(body.includes(identiconSvg(root)), "byte-identical to the console's");
        assert.ok(!body.includes("data:image"), "inlined, so img-src stays 'self'");
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

    it("serves DEEP paths under a persona - the SPA's routes resolve in the client", async () => {
        // Two path params, one handler: axum extracts positionally, so the deep route needs
        // its own destructuring (a 500 here was the widget gallery's first finding).
        const resp = await owner(`id/${root}/ui-demo`);
        assert.equal(resp.status, 200);
        assert.ok((await resp.text()).includes("app.js"), "a member gets the SPA to route it");
        const anonDeep = await anon(`id/${root}/ui-demo`);
        assert.equal(anonDeep.status, 200, "a stranger gets the persona's face, not a crash");
    });

    it("404s garbage that is not an address in any spelling", async () => {
        const resp = await anon("id/not-an-address-at-all-really");
        assert.equal(resp.status, 404);
    });

    it("tells the caller how to REACH this persona - itself, for one it hosts", async () => {
        const prof = await (await anon(`api/id/${root}/profile`)).json();
        assert.equal(prof.hosted, true, "this node serves them");
        assert.ok(prof.via.length >= 1, "and hints itself as an entry point");
        // Hints are base58 node keys - never hex, never addresses.
        assert.ok(prof.via.every((k) => /^[1-9A-HJ-NP-Za-km-z]+$/.test(k)));
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

/*
    Fetch-and-serve: a member of node B asks about a persona hosted only on node A, passing
    the address's ?via= hints - B dials A, syncs the public lane, and serves the profile.
    Ephemerality: the fetch never touches B's identities table, so B's anonymous face still
    tombstones the root (the shelf grows only through durable demand).
*/
/*
    The post permalink's read (2026-08-25): one post by id, under the same shelf rule as
    the page - and one honest 404 for never-was, private, and taken-down alike, because
    "which of those" is exactly what a stranger must not be able to distinguish.
*/
describe("the single-post read", () => {
    let owner, root, post, draft;

    before(async () => {
        owner = await makeUserFetch({ prefix: "permalink" });
        root = (await (await owner("api/identity", { method: "POST" })).json()).root_pubkey;
        await owner(`api/identity/${root}/serve`, { method: "POST" });
        const made = await (
            await owner(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "the addressed post",
                    body: "words with a home",
                    format: "plaintext",
                }),
            })
        ).json();
        const pub = await owner(`api/identity/${root}/docs/${made.doc_id}/publish`, {
            method: "POST",
        });
        post = JSON.parse(await pub.text()).post_id;
        // A private draft, never published: its id must answer exactly like nothing.
        draft = (
            await (
                await owner(`api/identity/${root}/docs`, {
                    method: "POST",
                    body: JSON.stringify({
                        title: "the unspoken draft",
                        body: "words with no public home",
                        format: "plaintext",
                    }),
                })
            ).json()
        ).doc_id;
        // Fold the owner's private views: without this read the draft has no doc_heads row
        // at all, and the draft-404 below would pass by ABSENCE rather than by the lane
        // filter - the first plant run proved exactly that (the dropped filter stayed
        // green). A listed draft is a materialized row, and now the filter is what stands
        // between it and the anonymous surface.
        await owner(`api/identity/${root}/docs`);
    });

    it("serves one post, anonymously, at its own address", async () => {
        const anon = makeFetch();
        const resp = await anon(`api/id/${root}/posts/${post}`);
        assert.equal(resp.status, 200, await resp.clone().text());
        const p = await resp.json();
        assert.equal(p.doc_id, post, "the post it asked for");
        assert.equal(p.title, "the addressed post");
        assert.ok(p.published_ms > 0, "dated by when it was first said");
    });

    it("a private draft is not a post - one honest 404", async () => {
        const anon = makeFetch();
        assert.equal((await anon(`api/id/${root}/posts/${draft}`)).status, 404);
    });

    it("garbage is a bad request, not a missing post", async () => {
        const anon = makeFetch();
        assert.equal((await anon(`api/id/${root}/posts/not-a-doc-id`)).status, 400);
    });

    it("a takedown leaves this surface too", async () => {
        const down = await owner(`api/identity/${root}/posts/${post}`, { method: "DELETE" });
        assert.equal(down.status, 200, await down.text());
        await beat(undefined, "fold", root);
        const anon = makeFetch();
        assert.equal(
            (await anon(`api/id/${root}/posts/${post}`)).status,
            404,
            "what was said and unsaid is not at its address any more"
        );
    });
});

const { HOST_B } = require("./fetch.cjs");

(HOST_B ? describe : describe.skip)("fetch-and-serve (A's persona through B)", function () {
    this.timeout(30000);

    let aOwner, bMember, aRoot, aEndpoint;

    before(async () => {
        aOwner = await makeUserFetch({ prefix: "ff_a" });
        const made = await (await aOwner("api/identity", { method: "POST" })).json();
        aRoot = made.root_pubkey;
        await aOwner(`api/identity/${aRoot}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Faraway Fran" }),
        });
        aEndpoint = (await (await aOwner("api/node")).json()).endpoint_id;
        bMember = await makeUserFetch({ prefix: "ff_b", host: HOST_B });
    });

    it("a member of B reaches A's persona through the via hint - base58-dressed", async () => {
        // Minted URLs carry node keys in base58 now; the hex escape hatch stays valid too.
        const { toBase58 } = await import("../../js/speakable.js");
        const resp = await bMember(`api/id/${aRoot}/profile?via=${toBase58(aEndpoint)}`);
        assert.equal(resp.status, 200);
        const prof = await resp.json();
        assert.equal(prof.foreign, true, "marked as reached-across, not hosted");
        assert.ok(
            prof.fields.some((f) => f.field === "name" && f.value === "Faraway Fran"),
            "the profile crossed the network"
        );
    });

    it("the fetch is member-scoped: anonymous B still tombstones the root", async () => {
        const anonB = makeFetch(HOST_B);
        const json = await anonB(`api/id/${aRoot}/profile`);
        assert.equal(json.status, 404, "the JSON face refuses strangers the fetch served");
        const face = await anonB(`id/${aRoot}`);
        assert.equal(face.status, 404, "the HTML face still tombstones - no durable shelf growth");
        assert.ok((await face.text()).includes("quiet side"));
    });

    it("a hintless ask about an unknown root fails honestly", async () => {
        const resp = await bMember(`api/id/${"dd".repeat(32)}/profile`);
        assert.equal(resp.status, 404);
    });

    it("NEVER hints itself for a persona it would tombstone", async () => {
        // B reached A's persona for its member, but B serves them to nobody - so B's answer
        // must carry A's entry point and refuse its own origin, or a shared link dead-ends.
        const { toBase58 } = await import("../../js/speakable.js");
        const prof = await (
            await bMember(`api/id/${aRoot}/profile?via=${toBase58(aEndpoint)}`)
        ).json();
        assert.equal(prof.hosted, false, "B does not host them - no origin may be minted");
        assert.ok(prof.via.includes(toBase58(aEndpoint)), "A's endpoint is the honest hint");
        const bEndpoint = (await (await bMember("api/node")).json()).endpoint_id;
        assert.ok(
            !prof.via.includes(toBase58(bEndpoint)),
            "B must not advertise itself as a way to reach them"
        );
    });

    it("adopting a fetched persona works, and clears its stranger record", async () => {
        // A SECOND persona of A's, fetched by B and then brought over - its own subject, so
        // adopting it can't rewrite the foreign world the tests above depend on. The
        // existing public-only copy is a prefix, not an obstacle (content-addressed
        // entries, duplicate-skip, incremental fold), so nothing is deleted and the private
        // half folds on top. First run of this path, 2026-08-03.
        const { inflateRawSync } = require("node:zlib");
        const decode = (c) =>
            JSON.parse(inflateRawSync(Buffer.from(c.trim().slice(4), "base64url")).toString("utf8"));
        const { toBase58 } = await import("../../js/speakable.js");

        const moved = await (await aOwner("api/identity", { method: "POST" })).json();
        await aOwner(`api/identity/${moved.root_pubkey}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "Moving Mo" }),
        });
        // B fetches them first - the public-only copy this test is about.
        const before = await (
            await bMember(`api/id/${moved.root_pubkey}/profile?via=${toBase58(aEndpoint)}`)
        ).json();
        assert.equal(before.foreign, true, "a stranger, held publicly");

        const owner = await makeUserFetch({ prefix: "adopt_b", host: HOST_B });
        const req = await (await owner("api/identity/adopt/begin", { method: "POST" })).json();
        assert.ok(decode(req.code).leaf_pubkey, "the request code carries a leaf");
        const grant = await (
            await aOwner(`api/identity/${moved.root_pubkey}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: req.code }),
            })
        ).json();
        const done = await owner("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });
        assert.equal(done.status, 200, await done.text());

        const mine = await (await owner("api/identity")).json();
        assert.ok(mine.some((p) => p.root_pubkey === moved.root_pubkey), "B hosts them now");
        const after = await (await owner(`api/id/${moved.root_pubkey}/profile`)).json();
        assert.equal(after.hosted, true, "hosted, not foreign");
        assert.equal(after.foreign, false);
        // And B stops calling them a stranger it once fetched.
        const rows = await sql("SELECT root_pubkey FROM foreign_fetches", HOST_B);
        assert.ok(
            !JSON.stringify(rows).includes(moved.root_pubkey),
            "the fetch record is cleared when hosting begins"
        );
    });

    it("the fetch is REMEMBERED: a bare hintless ask now serves from the durable registry", async () => {
        // No ?via= at all - the on-disk foreign_fetches row (freshness + last_via) is the
        // only thing that can answer this. This is the row that survives a reboot.
        const resp = await bMember(`api/id/${aRoot}/profile`);
        assert.equal(resp.status, 200);
        const prof = await resp.json();
        assert.equal(prof.foreign, true);
        assert.ok(prof.fields.some((f) => f.value === "Faraway Fran"));
    });
});

/*
    The avatar: tenant zero of the public documents lane. Upload crushes to a born-public
    media doc on POSTS; the profile's `avatar` register points at it; the bytes serve
    anonymously under the identity-rooted path with immutable caching.
*/
let owner2, root2, avatarDoc;

describe("the avatar (public documents, tenant zero)", function () {
    this.timeout(30000);

    before(async () => {
        owner2 = await makeUserFetch({ prefix: "avatar" });
        const made = await (await owner2("api/identity", { method: "POST" })).json();
        root2 = made.root_pubkey;
        const fs = require("node:fs");
        const img = fs.readFileSync(`${__dirname}/../../../sample_media/polaroid.jpg`);
        const form = new FormData();
        form.append("image", new Blob([img], { type: "image/jpeg" }), "polaroid.jpg");
        const resp = await owner2(`api/identity/${root2}/avatar`, {
            method: "POST",
            body: form,
            file: true,
        });
        const text = await resp.text();
        assert.equal(resp.status, 200, text);
        avatarDoc = JSON.parse(text).doc_id;
    });

    it("mints a public media document and points the profile at it", async () => {
        const prof = await (await anon(`api/id/${root2}/profile`)).json();
        assert.ok(
            prof.fields.some((f) => f.field === "avatar" && f.value === avatarDoc),
            "the register holds the pointer"
        );
    });

    it("serves the bytes anonymously under the identity-rooted path", async () => {
        const thumb = await anon(`id/${root2}/docs/${avatarDoc}/thumb`);
        assert.equal(thumb.status, 200);
        assert.equal(thumb.headers.get("content-type"), "image/avif");
        // Revalidation, not immutability (2026-08-06): the URL names the DOCUMENT, and a
        // re-uploaded avatar changes these bytes under the same address. The blob hash rides
        // as the ETag, so an unchanged thumb costs a 304 and never a year of staleness.
        assert.ok(!/immutable/.test(thumb.headers.get("cache-control") || ""));
        assert.ok(thumb.headers.get("etag"), "the blob hash rides as the ETag");
        const body = await anon(`id/${root2}/docs/${avatarDoc}/body`);
        assert.equal(body.status, 200);
        assert.equal(body.headers.get("content-type"), "image/avif");
        assert.ok((await body.arrayBuffer()).byteLength > 0, "real bytes");
    });

    it("the face wears it", async () => {
        const face = await anon(`id/${root2}`);
        assert.ok((await face.text()).includes(`/docs/${avatarDoc}/thumb`));
    });

    it("a PRIVATE doc asked through the public door is a 404, never a leak", async () => {
        const doc = await (await owner2(`api/identity/${root2}/docs`, {
            method: "POST",
            body: JSON.stringify({ title: "secret", body: "private words", format: "plaintext" }),
        })).json();
        const resp = await anon(`id/${root2}/docs/${doc.doc_id}/body`);
        assert.equal(resp.status, 404);
    });

    it("the avatar never appears in the private workspace list", async () => {
        const list = await (await owner2(`api/identity/${root2}/docs`)).json();
        const docs = Array.isArray(list) ? list : list.docs || [];
        assert.ok(
            !docs.some((d) => d.doc_id === avatarDoc),
            "public docs have their own doors; the apps never see them"
        );
    });
});

(HOST_B ? describe : describe.skip)("foreign bodies cross with the fetch", function () {
    this.timeout(30000);

    it("names AND faces: B serves A's avatar bytes after one via-hinted fetch", async () => {
        // root2's avatar was minted in the section above on A; a member of B reaches across.
        const aEndpoint = (await (await owner2("api/node")).json()).endpoint_id;
        const bMember = await makeUserFetch({ prefix: "face_b", host: HOST_B });
        const prof = await (
            await bMember(`api/id/${root2}/profile?via=${aEndpoint}`)
        ).json();
        assert.ok(
            prof.fields.some((f) => f.field === "avatar" && f.value === avatarDoc),
            "the avatar pointer crossed with the profile"
        );
        // The bytes crossed in the same exchange (keyless public backfill): B can serve the
        // thumbnail itself, no second trip to A.
        // The face lands with the look's shelf, behind the answer (PEEK.md ruling 9): a
        // moment, never a second trip to A.
        let thumb = await bMember(`id/${root2}/docs/${avatarDoc}/thumb`);
        for (let i = 0; i < 30 && thumb.status !== 200; i++) {
            await new Promise((r) => setTimeout(r, 400));
            thumb = await bMember(`id/${root2}/docs/${avatarDoc}/thumb`);
        }
        assert.equal(thumb.status, 200, "the face crossed, not just the name");
        assert.equal(thumb.headers.get("content-type"), "image/avif");
        assert.ok((await thumb.arrayBuffer()).byteLength > 0);
    });
});
