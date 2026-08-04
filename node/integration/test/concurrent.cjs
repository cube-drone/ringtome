/*
    Two writes at once, from one person.

    A single request can legitimately author more than one entry at a time - Feed posts by
    publishing and minting the next draft in parallel - and every entry on a chain derives its
    seq from the chain head. Overlapping appends used to race between that read and the insert,
    and the loser died on the `(author, service, seq)` primary key as a 500 reading "storing
    entry": no explanation, mid-action, and the post left sitting as a draft. The primary key is
    the backstop; it should not be what users meet.
*/
const assert = require("node:assert");
const { makeUserFetch } = require("./helpers.cjs");

let owner, root;

before(async () => {
    owner = await makeUserFetch({ prefix: "concur" });
    const made = await (await owner("api/identity", { method: "POST" })).json();
    root = made.root_pubkey;
});

describe("concurrent authorship", () => {
    it("takes eight documents created at once, and loses none", async () => {
        const made = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                owner("api/identity/" + root + "/docs", {
                    method: "POST",
                    body: JSON.stringify({ title: `at once ${i}`, body: "x", format: "plaintext" }),
                })
            )
        );
        for (const r of made) {
            assert.equal(r.status, 200, await r.text());
        }
        const list = await (await owner(`api/identity/${root}/docs`)).json();
        const docs = Array.isArray(list) ? list : list.docs || [];
        const titles = docs.map((d) => d.title).filter((t) => t.startsWith("at once "));
        assert.equal(new Set(titles).size, 8, "all eight are there, exactly once each");
    });

    it("publishes while another write lands - Feed's own shape", async () => {
        const note = await (
            await owner(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Simultaneous", body: "said", format: "plaintext" }),
            })
        ).json();
        // Publish and mint the next draft together, which is exactly what the Feed app does
        // the moment you press Post.
        const [pub, mint] = await Promise.all([
            owner(`api/identity/${root}/docs/${note.doc_id}/publish`, { method: "POST" }),
            owner(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "", body: "", format: "marquee" }),
            }),
        ]);
        assert.equal(pub.status, 200, await pub.text());
        assert.equal(mint.status, 200, await mint.text());
    });

    it("keeps the chain a chain - one entry per seq, no gaps", async () => {
        const entries = await (await owner(`api/identity/${root}/entries`)).json();
        const list = Array.isArray(entries) ? entries : entries.entries || [];
        const bySeq = new Map();
        for (const e of list) {
            const key = `${e.service}:${e.seq}`;
            assert.ok(!bySeq.has(key), `two entries claim ${key}`);
            bySeq.set(key, e);
        }
        // Every service's sequence runs 0..n with nothing missing: a lost append would show
        // up here as a hole, which is the failure a retry-on-conflict would have left behind.
        const perService = new Map();
        for (const e of list) {
            perService.set(e.service, (perService.get(e.service) || []).concat(e.seq));
        }
        for (const [service, seqs] of perService) {
            const sorted = [...seqs].sort((a, b) => a - b);
            assert.deepEqual(
                sorted,
                sorted.map((_, i) => i),
                `service ${service} runs 0..n without a gap`
            );
        }
    });
});
