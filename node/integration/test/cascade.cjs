/*
    The share tree, walked to its full depth: four nodes, four hops, no shortcuts.

        A (alpha)  writes and publishes.
        B (bravo)  follows A, shares the post.          holds A's CHAIN.
        C (charlie) follows B for rebroadcasts, shares  holds only a FRAGMENT, origin B.
                    the post onward.
        D (echo)   follows C for rebroadcasts.          holds only a FRAGMENT, origin C.

    Every node here runs with RINGTOME_TEST_TREE_ONLY, which disables the author-first
    revalidation lane. That is the point of this file: the fast lane works because it is simple,
    and the TREE is the fallback that keeps a share alive and honest when the author is dark -
    a fallback that is never exercised is a fallback that has rotted by the time it matters. So
    these tests prove the hard path on purpose, hop by hop:

        an EDIT   flows A -> B by chain sync, B -> C and C -> D by fragment revalidation;
        a DELETE  flows the same way, and C's hop is the load-bearing one: C drops the content
                  and keeps the TOMBSTONE, which is the only way D can ever hear `Gone` from a
                  node that no longer has anything else to say about the document.

    Each scenario seeds its own document through the whole chain before acting, so a failure in
    one path can never decide the outcome of another - the lesson of the first version of these
    tests, where one shared post carried every assertion and the edit contaminated the deletes.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = async (fn, tries = 240) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

const feedOf = async (reader, host) => {
    const { rows } = await sql(
        `SELECT author_root, via_root, doc_id, title FROM feed_journal WHERE reader_root = '${reader}'`,
        host
    );
    return rows;
};

const fragmentsOf = async (author, host) => {
    const { rows } = await sql(
        `SELECT doc_id, title FROM fragments WHERE author_root = '${author}'`,
        host
    );
    return rows;
};

const tombstonesOf = async (author, host) => {
    const { rows } = await sql(
        `SELECT doc_id FROM fragment_tombstones WHERE author_root = '${author}'`,
        host
    );
    return rows;
};

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

const dial = (fetcher, mine, theirs, key, value) =>
    fetcher(`api/identity/${mine}/private/kv/contact:${theirs}/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
    });

(HOST_B && HOST_C && HOST_E ? describe : describe.skip)("the share tree, four hops deep", function () {
    this.timeout(600000);

    let alice, aliceRoot, bob, bobRoot, cleo, cleoRoot, dana, danaRoot;

    before(async function () {
        alice = await makeUserFetch({ prefix: "cascalice" });
        aliceRoot = (await (await alice("api/identity", { method: "POST" })).json()).root_pubkey;
        await alice(`api/identity/${aliceRoot}/serve`, { method: "POST" });
        const viaAlice = await base58(alice);

        bob = await makeUserFetch({ prefix: "cascbob", host: HOST_B });
        bobRoot = (await (await bob("api/identity", { method: "POST" })).json()).root_pubkey;
        await bob(`api/identity/${bobRoot}/serve`, { method: "POST" });
        const viaBob = await base58(bob);

        cleo = await makeUserFetch({ prefix: "casccleo", host: HOST_C });
        cleoRoot = (await (await cleo("api/identity", { method: "POST" })).json()).root_pubkey;
        await cleo(`api/identity/${cleoRoot}/serve`, { method: "POST" });
        const viaCleo = await base58(cleo);

        dana = await makeUserFetch({ prefix: "cascdana", host: HOST_E });
        danaRoot = (await (await dana("api/identity", { method: "POST" })).json()).root_pubkey;

        // The chain of relationships, each hop deliberately narrower than the last: Bob follows
        // Alice outright; Cleo wants only what Bob shares; Dana only what Cleo shares. Nobody
        // past Bob has any relationship to Alice at all.
        if ((await bob(`api/id/${aliceRoot}/profile?via=${viaAlice}`)).status !== 200) this.skip();
        await dial(bob, bobRoot, aliceRoot, "interest", "high");

        if ((await cleo(`api/id/${bobRoot}/profile?via=${viaBob}`)).status !== 200) this.skip();
        await dial(cleo, cleoRoot, bobRoot, "interest_rebroadcasts", "high");

        if ((await dana(`api/id/${cleoRoot}/profile?via=${viaCleo}`)).status !== 200) this.skip();
        await dial(dana, danaRoot, cleoRoot, "interest_rebroadcasts", "high");
    });

    /// One document, pushed through the whole chain: Alice publishes, Bob shares, Cleo shares
    /// onward, and the return value arrives only once Dana can see it. Every scenario starts
    /// here, with its own document, so the scenarios cannot contaminate each other.
    async function seed(title) {
        const made = await (
            await alice(`api/identity/${aliceRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title, body: `${title}: the words`, format: "plaintext" }),
            })
        ).json();
        const published = await alice(`api/identity/${aliceRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
        });
        const pubBody = await published.text();
        assert.equal(published.status, 200, pubBody);
        const post = JSON.parse(pubBody).post_id;

        assert.ok(
            await settle(async () => {
                const rows = await feedOf(bobRoot, HOST_B);
                return rows.some((r) => r.doc_id === post) ? true : null;
            }),
            `seed(${title}): the post reached Bob`
        );
        const bobShared = await bob(`api/identity/${bobRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: aliceRoot, doc_id: post }),
        });
        assert.equal(bobShared.status, 200, await bobShared.text());

        assert.ok(
            await settle(async () => {
                const rows = await feedOf(cleoRoot, HOST_C);
                return rows.some((r) => r.doc_id === post && r.via_root === bobRoot) ? true : null;
            }),
            `seed(${title}): Bob's share reached Cleo as a fragment`
        );
        const cleoShared = await cleo(`api/identity/${cleoRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: aliceRoot, doc_id: post }),
        });
        assert.equal(cleoShared.status, 200, await cleoShared.text());

        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                return rows.some((r) => r.doc_id === post && r.via_root === cleoRoot) ? true : null;
            }),
            `seed(${title}): Cleo's share reached Dana - the fourth hop`
        );
        return { post, draft: made.doc_id, version: made.version };
    }

    /// Edit the draft and republish, returning the new private version for chained edits.
    async function editAndRepublish(draft, parents, title) {
        const put = await alice(`api/identity/${aliceRoot}/docs/${draft}`, {
            method: "PUT",
            body: JSON.stringify({ title, body: `${title}: the words`, parents: [parents], format: "plaintext" }),
        });
        const putBody = await put.text();
        assert.equal(put.status, 200, putBody);
        const version = JSON.parse(putBody).version;
        const rep = await alice(`api/identity/${aliceRoot}/docs/${draft}/publish`, {
            method: "POST",
        });
        const repBody = await rep.text();
        assert.equal(rep.status, 200, repBody);
        return version;
    }

    it("an edit reaches the fourth hop", async () => {
        const { post, draft, version } = await seed("edit-once");
        await editAndRepublish(draft, version, "edit-once, revised");

        const row = await settle(async () => {
            const rows = await feedOf(danaRoot, HOST_E);
            const r = rows.find((x) => x.doc_id === post);
            return r && r.title.includes("revised") ? r : null;
        });
        assert.ok(row, "the revision travelled A->B by sync, B->C and C->D by revalidation");
        assert.equal(row.author_root, aliceRoot, "still Alice's words");
        assert.equal(row.via_root, cleoRoot, "still bylined via Cleo");
    });

    it("edits stack: the fourth hop converges on the newest", async () => {
        const { post, draft, version } = await seed("edit-twice");
        const v2 = await editAndRepublish(draft, version, "edit-twice, second thoughts");
        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                const r = rows.find((x) => x.doc_id === post);
                return r && r.title.includes("second thoughts") ? true : null;
            }),
            "the first revision arrived before the second was made"
        );
        await editAndRepublish(draft, v2, "edit-twice, final say");

        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                const r = rows.find((x) => x.doc_id === post);
                return r && r.title.includes("final say") ? true : null;
            }),
            "the fourth hop converges on the newest version, not whichever arrived"
        );
    });

    it("a delete reaches the fourth hop, and the tombstone is what carries it", async () => {
        const { post, draft } = await seed("doomed");

        // Deleting the DRAFT is housekeeping and must not travel: the post stands.
        const draftGone = await alice(`api/identity/${aliceRoot}/docs/${draft}`, {
            method: "DELETE",
        });
        assert.equal(draftGone.status, 200, await draftGone.text());
        await new Promise((r) => setTimeout(r, 4000));
        assert.ok(
            (await feedOf(danaRoot, HOST_E)).some((r) => r.doc_id === post),
            "deleting the draft left the published post standing at hop four"
        );

        // Unpublishing is the public act, and it walks the tree.
        const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, { method: "DELETE" });
        assert.equal(down.status, 200, await down.text());

        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                return rows.some((r) => r.doc_id === post) ? null : true;
            }),
            "the takedown reached the fourth hop"
        );
        // The mechanism, not just the outcome: C dropped the words and kept the FACT, and that
        // memo is the only thing that can have told D - C never held Alice's chain, and with
        // the fast lane off, D can only ever ask C.
        assert.equal(
            (await fragmentsOf(aliceRoot, HOST_C)).filter((r) => r.doc_id === post).length,
            0,
            "Cleo dropped her copy"
        );
        assert.equal(
            (await tombstonesOf(aliceRoot, HOST_C)).filter((r) => r.doc_id === post).length,
            1,
            "and kept the fact of the deletion"
        );
        assert.equal(
            (await fragmentsOf(aliceRoot, HOST_E)).filter((r) => r.doc_id === post).length,
            0,
            "Dana dropped hers"
        );
        assert.equal(
            (await tombstonesOf(aliceRoot, HOST_E)).filter((r) => r.doc_id === post).length,
            1,
            "and can answer for it to a fifth hop that does not exist yet"
        );
    });

    it("an edit followed by a delete lands as deleted, everywhere", async () => {
        const { post, draft, version } = await seed("edited-then-doomed");
        await editAndRepublish(draft, version, "edited-then-doomed, revised");
        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                const r = rows.find((x) => x.doc_id === post);
                return r && r.title.includes("revised") ? true : null;
            }),
            "the edit landed at hop four first"
        );

        const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, { method: "DELETE" });
        assert.equal(down.status, 200, await down.text());
        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                return rows.some((r) => r.doc_id === post) ? null : true;
            }),
            "and then the takedown overtook it"
        );
        assert.equal(
            (await tombstonesOf(aliceRoot, HOST_E)).filter((r) => r.doc_id === post).length,
            1,
            "the tombstone stands at the deepest hop"
        );
    });
});
