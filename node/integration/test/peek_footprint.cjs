/*
    PEEK.md slice 3: a peek has a footprint and an expiry. The rig runs every node with a
    32 KB per-peek ceiling (justfile: RINGTOME_PEEK_MAX_BYTES=32768), so a stranger whose
    posts are four kilobytes each cannot all cross: the look fetches bodies in shelf order
    until the ceiling, wants nothing past it, and says so. The evict beat (whose default peek
    expiry is zero: it evicts on claims, never on clocks) retires the peek whole - mirror,
    fragments, registry row - and a fresh look peeks again; rung with an hour's expiry, a
    peek somebody just looked at stays.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { sql, HOST_B } = require("./fetch.cjs");

const POSTS = 20;
const BODY = "x".repeat(4000);
const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

(HOST_B ? describe : describe.skip)("a peek's footprint and expiry", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, posts;

    const held = async () => ({
        chains: (await sql(`SELECT count(*) AS n FROM chain_heads WHERE root_pubkey = '${adaRoot}'`, HOST_B)).rows[0].n,
        fragments: (await sql(`SELECT count(*) AS n FROM fragments WHERE author_root = '${adaRoot}'`, HOST_B)).rows[0].n,
        registry: (await sql(`SELECT count(*) AS n FROM foreign_fetches WHERE root_pubkey = '${adaRoot}'`, HOST_B)).rows[0].n,
    });

    before(async function () {
        ada = await makeUserFetch({ prefix: "footada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        for (let i = 0; i < POSTS; i++) {
            const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: `heavy ${i}`, body: `${i}:${BODY}`, format: "plaintext" })).json();
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
            assert.equal(pub.status, 200, await pub.text());
        }
        bea = await makeUserFetch({ prefix: "footbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        const r = await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
        if (r.status !== 200) this.skip();
        posts = (await r.json()).posts || [];
        // The shelf lands behind the answer (ruling 9): wait for the headers.
        for (let i = 0; i < 30 && posts.length < POSTS; i++) {
            await new Promise((res) => setTimeout(res, 400));
            posts = ((await (await bea(`api/id/${adaRoot}/profile`)).json()).posts) || [];
        }
    });

    it("the look stops at its ceiling: some bodies crossed in shelf order, the rest are refused with the word, and the page says it is full", async () => {
        assert.equal(posts.length, POSTS, "the headers all came - they are small");
        let crossed = 0;
        let refused = 0;
        let firstRefusal = -1;
        for (let i = 0; i < posts.length; i++) {
            const r = await bea(`id/${adaRoot}/docs/${posts[i].doc_id}/body`);
            if (r.status === 200) {
                assert.ok(firstRefusal === -1, "bodies crossed in shelf order: none after a refusal");
                crossed += 1;
            } else {
                if (firstRefusal === -1) firstRefusal = i;
                refused += 1;
                assert.match(await r.text(), /this look is full/, "the refusal has the word");
            }
        }
        assert.ok(crossed >= 2 && crossed < POSTS, `the ceiling bit partway: ${crossed} crossed, ${refused} refused`);
        const profile = await (await bea(`api/id/${adaRoot}/profile`)).json();
        assert.equal(profile.peek, true);
        assert.equal(profile.peek_full, true, "the page says the look is full");
        const bytes = (await sql(`SELECT bytes FROM foreign_fetches WHERE root_pubkey = '${adaRoot}'`, HOST_B)).rows[0].bytes;
        assert.ok(Number(bytes) >= 32768, `the registry measured the footprint: ${bytes}`);
    });

    it("the evict beat with a zero expiry retires the peek whole, and a fresh look peeks again", async () => {
        const before = await held();
        assert.ok(Number(before.chains) > 0 && Number(before.fragments) === POSTS && Number(before.registry) === 1, JSON.stringify(before));
        const rung = await bea("test/beat", { method: "POST", body: JSON.stringify({ pass: "evict", peek_expiry_ms: 0 }) });
        assert.equal(rung.status, 200, await rung.text());
        const after = await held();
        assert.deepEqual(after, { chains: 0, fragments: 0, registry: 0 }, `the peek is gone: ${JSON.stringify(after)}`);
        const again = await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
        assert.equal(again.status, 200);
        let prof = await again.json();
        assert.equal(prof.peek, true, "peeked again");
        // The shelf lands behind the answer (ruling 9): wait for it as the page does.
        for (let i = 0; i < 30 && (prof.posts || []).length < POSTS; i++) {
            await new Promise((res) => setTimeout(res, 400));
            prof = await (await bea(`api/id/${adaRoot}/profile`)).json();
        }
        assert.equal((prof.posts || []).length, POSTS, "the shelf came again");
        for (let i = 0; i < 30 && Number((await held()).fragments) < POSTS; i++) {
            await new Promise((res) => setTimeout(res, 400));
        }
    });

    it("a peek somebody keeps looking at is not expired under a real expiry", async () => {
        const rung = await bea("test/beat", { method: "POST", body: JSON.stringify({ pass: "evict", peek_expiry_ms: 3600000 }) });
        assert.equal(rung.status, 200, await rung.text());
        const still = await held();
        assert.equal(Number(still.registry), 1, "the registry row stands under the real expiry");
        assert.equal(Number(still.fragments), POSTS);
    });
});
