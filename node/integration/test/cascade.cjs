/*
    The share tree, walked to its full depth: four nodes, four hops, no shortcuts.

        A (alpha)  writes and publishes.
        B (bravo)  follows A, shares the post.          holds A's CHAIN.
        C (charlie) follows B for rebroadcasts, shares  holds only a FRAGMENT, origin B.
                    the post onward.
        D (echo)   follows C for rebroadcasts.          holds only a FRAGMENT, origin C.

    The same four shapes run TWICE, through both revalidation lanes (`/test/revalidation`
    toggles the harness's boot default at runtime). Tree-only proves the fallback that keeps a
    share alive and honest when the author is dark - a fallback never exercised has rotted by
    the time it matters. Fast-lane proves production's shape, where readers ask the author
    first. The asserted states are identical; who answered is what differs. Hop by hop:

        an EDIT   flows A -> B by chain sync, B -> C and C -> D by fragment revalidation;
        a DELETE  flows the same way, and C's hop is the load-bearing one: C drops the content
                  and keeps the TOMBSTONE, which is the only way D can ever hear `Gone` from a
                  node that no longer has anything else to say about the document.

    Each scenario seeds its own document through the whole chain before acting, so a failure in
    one path can never decide the outcome of another - the lesson of the first version of these
    tests, where one shared post carried every assertion and the edit contaminated the deletes.

    A THIRD block runs the same three claims - serve, edit, delete - with the fast lane on and
    Alice's node actually unreachable (`/test/unplug`). Both lanes above are policy: `tree` asks
    the tree because it was told to. Only that block proves the fast lane FALLS BACK, which is the
    case the share tree exists for and the one production will meet.

    A FOURTH block turns the cascade around. Every block above walks a delete FORWARD through a
    network where everyone hears in order, which is not a property any real network has. The last
    one partitions a sharer so she never hears at all, and then has her offer the dead post back to
    a reader who has already buried it - the direction in which "speech deletes" is a claim about
    MEMORY rather than about propagation.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { unplug, plugIn } = require("./unplug.cjs");

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

// `version` is the entry hash: the identity of the exact version held, which is how a test can
// tell "still the copy it had" from "refetched something new".
const fragmentsOf = async (author, host) => {
    const { rows } = await sql(
        `SELECT doc_id, title, version FROM fragments WHERE author_root = '${author}'`,
        host
    );
    return rows;
};

// `entry` rides along so the suite can assert a tombstone is EVIDENCE and not hearsay: since
// 2026-08-13 the memo holds the author's own signed retraction, verified on receipt and served
// onward - a node past the chain buries nothing it cannot prove.
const tombstonesOf = async (author, host) => {
    const { rows } = await sql(
        `SELECT doc_id, length(entry) AS proof_bytes FROM fragment_tombstones WHERE author_root = '${author}'`,
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

const { makeFetch } = require("./fetch.cjs");

/// Point every revalidating node's lane the same way. Only C and D revalidate in this topology
/// (B holds the author's chain and A is the author), but setting all four keeps the suite
/// honest if the topology ever grows.
async function setLane(mode) {
    for (const host of [undefined, HOST_B, HOST_C, HOST_E]) {
        const f = makeFetch(host);
        const res = await f("test/revalidation", {
            method: "POST",
            body: JSON.stringify({ mode }),
        });
        assert.equal(res.status, 200, `setting revalidation mode on ${host || "A"}`);
    }
}

(HOST_B && HOST_C && HOST_E ? describe : describe.skip)("the share tree, four hops deep", function () {
    this.timeout(1200000);

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

    /// The first three hops: Alice publishes, Bob shares, and the return value arrives only once
    /// Cleo holds a fragment. Split out from `seed` so a scenario can stop the chain HERE and
    /// change the world before the fourth hop runs (the author-dark tests below do exactly that:
    /// the last hop has to happen with Alice's node already gone).
    async function seedToCleo(title) {
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
        return { post, draft: made.doc_id, version: made.version };
    }

    /// The fourth hop: Cleo shares onward, and Dana holds a fragment whose origin is Cleo.
    async function shareOnwardToDana(post, label) {
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
            `seed(${label}): Cleo's share reached Dana - the fourth hop`
        );
    }

    /// One document, pushed through the whole chain. Every scenario starts here, with its own
    /// document, so the scenarios cannot contaminate each other.
    async function seed(title) {
        const seeded = await seedToCleo(title);
        await shareOnwardToDana(seeded.post, title);
        return seeded;
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

    /// The four shapes, shared verbatim between the two lanes: the asserted STATES are identical
    /// - what differs is who answered, and each lane's describe pins that in its own before().
    function scenarios(tag) {
    it(`an edit reaches the fourth hop [${tag}]`, async () => {
        const { post, draft, version } = await seed(`edit-once-${tag}`);
        await editAndRepublish(draft, version, `edit-once-${tag}, revised`);

        const row = await settle(async () => {
            const rows = await feedOf(danaRoot, HOST_E);
            const r = rows.find((x) => x.doc_id === post);
            return r && r.title.includes("revised") ? r : null;
        });
        assert.ok(row, "the revision travelled A->B by sync, B->C and C->D by revalidation");
        assert.equal(row.author_root, aliceRoot, "still Alice's words");
        assert.equal(row.via_root, cleoRoot, "still bylined via Cleo");
    });

    it(`edits stack: the fourth hop converges on the newest [${tag}]`, async () => {
        const { post, draft, version } = await seed(`edit-twice-${tag}`);
        const v2 = await editAndRepublish(draft, version, `edit-twice-${tag}, second thoughts`);
        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                const r = rows.find((x) => x.doc_id === post);
                return r && r.title.includes("second thoughts") ? true : null;
            }),
            "the first revision arrived before the second was made"
        );
        await editAndRepublish(draft, v2, `edit-twice-${tag}, final say`);

        assert.ok(
            await settle(async () => {
                const rows = await feedOf(danaRoot, HOST_E);
                const r = rows.find((x) => x.doc_id === post);
                return r && r.title.includes("final say") ? true : null;
            }),
            "the fourth hop converges on the newest version, not whichever arrived"
        );
    });

    it(`a delete reaches the fourth hop, and the tombstone is what carries it [${tag}]`, async () => {
        const { post, draft } = await seed(`doomed-${tag}`);

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
        const cleoTomb = (await tombstonesOf(aliceRoot, HOST_C)).filter((r) => r.doc_id === post);
        assert.equal(cleoTomb.length, 1, "and kept the fact of the deletion");
        assert.ok(
            cleoTomb[0].proof_bytes > 0,
            "and the fact is the author's own signed retraction, not Cleo's say-so"
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

    it(`an edit followed by a delete lands as deleted, everywhere [${tag}]`, async () => {
        const { post, draft, version } = await seed(`edited-then-doomed-${tag}`);
        await editAndRepublish(draft, version, `edited-then-doomed-${tag}, revised`);
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
    }

    describe("through the tree alone (fast lane off)", function () {
        // The fallback's lane, proven on purpose: a fallback never exercised has rotted by the
        // time the author goes dark. Deletion here can only travel via C's tombstone - C never
        // held Alice's chain, and D can only ever ask C.
        before(() => setLane("tree"));
        scenarios("tree");
    });

    describe("with the fast lane on (production's shape)", function () {
        // The same four shapes, revalidating author-first. Same asserted states - Gone still
        // entombs, edits still land - but the answers come from Alice directly, which is what
        // every real reader does while the author is reachable.
        before(() => setLane("fast"));
        after(() => setLane("default"));
        scenarios("fast");
    });

    /*
        The author actually goes away.

        The two lanes above are policy: `tree` asks the tree because it was TOLD to, which proves
        the fallback's code runs but never proves it is reached. Production runs the fast lane, and
        the fast lane only falls back when the author's node genuinely does not answer - the moment
        the whole share tree exists for, and the one no test could reach until `/test/unplug`.

        So these run with the fast lane ON and Alice's node dark, which makes each assertion a claim
        about the network rather than about a config flag: readers try the author first, get nothing,
        and the chain has to carry it.

        WHY THE TWO-PHASE DARKNESS. Alice's chain reaches Bob over the SYNC alpn; readers ask her for
        fragments over the FRAGMENT alpn. If she stayed fully reachable while an edit or a takedown
        travelled to Bob, the sweeps - every ~1.5s here - would let Cleo and Dana learn it straight
        from Alice, and the test would pass with the share tree carrying nothing at all. So her
        fragment door is shut BEFORE the act, which makes every later arrival provably second-hand,
        and her node then goes fully dark before the deepest hop. What is asserted after that point
        happened with the author's node answering nobody, about anything.
    */
    describe("with the author's node dark (the fallback's real case)", function () {
        before(() => setLane("fast"));
        after(() => setLane("default"));

        // Belt; `roothooks.cjs` is the braces. A test that dies mid-partition must not leave alpha
        // dark for the rest of the suite.
        afterEach(() => plugIn(HOST));

        it("a share is served onward while the author is dark", async () => {
            // The plainest form of the claim: a reader who has NEVER held this document gets a
            // complete, verified copy of it at a moment when its author is unreachable. Nothing
            // here is preserved-by-inertia - the fragment Dana ends up with did not exist when
            // Alice went dark, so the chain did not merely keep its copies, it served a new one.
            const { post } = await seedToCleo("dark-serve");

            await unplug(HOST);
            await shareOnwardToDana(post, "dark-serve");

            const row = (await feedOf(danaRoot, HOST_E)).find((r) => r.doc_id === post);
            assert.ok(row, "the fourth hop landed with the author's node dark");
            assert.equal(row.author_root, aliceRoot, "still credited to Alice, who never answered");
            assert.equal(row.via_root, cleoRoot, "and bylined via the node that actually served it");

            // The words themselves, not just a feed row pointing at them: Dana holds the author's
            // own signed entry, verified against a delegation path that travelled with it.
            const held = (await fragmentsOf(aliceRoot, HOST_E)).find((r) => r.doc_id === post);
            assert.ok(held, "Dana holds the fragment itself");
            assert.equal(held.title, "dark-serve", "with the author's title intact");
            assert.equal(
                (await tombstonesOf(aliceRoot, HOST_E)).filter((r) => r.doc_id === post).length,
                0,
                "an author who cannot be reached has not deleted anything"
            );
        });

        it("an unreachable author is not a deleted one", async () => {
            // The safety property the whole design rests on, and the one whose failure would be a
            // catastrophe rather than a bug: if a failed revalidation were read as a takedown,
            // closing your laptop would erase your work from everyone who shared it. Silence
            // preserves, speech deletes (fragments::sweep).
            const { post } = await seed("dark-survives");
            const before = (await fragmentsOf(aliceRoot, HOST_E)).find((r) => r.doc_id === post);
            assert.ok(before, "precondition: Dana holds it");

            await unplug(HOST);
            // Long enough for many rounds at both hops - the revalidation interval here is 500ms
            // and the sweep beat 1.5s, so this is a dozen or more chances to get it wrong.
            await new Promise((r) => setTimeout(r, 12000));

            const after = (await fragmentsOf(aliceRoot, HOST_E)).find((r) => r.doc_id === post);
            assert.ok(after, "Dana still holds the fragment after the author stopped answering");
            assert.equal(after.version, before.version, "and it is the same version, not a refetch");
            assert.ok(
                (await feedOf(danaRoot, HOST_E)).some((r) => r.doc_id === post),
                "and it is still in her feed"
            );
            for (const [who, host] of [["Cleo", HOST_C], ["Dana", HOST_E]]) {
                assert.equal(
                    (await tombstonesOf(aliceRoot, host)).filter((r) => r.doc_id === post).length,
                    0,
                    `${who} did not entomb a post whose author merely went offline`
                );
            }
        });

        it("an edit reaches the fourth hop after the author goes dark", async () => {
            const { post, draft, version } = await seed("dark-edit");

            // Phase one: Alice can still sync her chain to Bob, but answers no fragment asks - so
            // anything Cleo or Dana learn from here on came through the tree.
            await unplug(HOST, { alpns: ["fragment"] });
            await editAndRepublish(draft, version, "dark-edit, revised");

            assert.ok(
                await settle(async () => {
                    const r = (await feedOf(cleoRoot, HOST_C)).find((x) => x.doc_id === post);
                    return r && r.title.includes("revised") ? true : null;
                }),
                "the revision crossed A->B by chain sync and B->C by revalidation, not from Alice"
            );

            // Phase two: the author's node is gone entirely. The last hop is on its own.
            await unplug(HOST);
            const row = await settle(async () => {
                const r = (await feedOf(danaRoot, HOST_E)).find((x) => x.doc_id === post);
                return r && r.title.includes("revised") ? r : null;
            });
            assert.ok(row, "the revision reached the fourth hop with the author's node dark");
            assert.equal(row.author_root, aliceRoot, "still Alice's words");
            assert.equal(row.via_root, cleoRoot, "still bylined via Cleo");
            assert.equal(
                (await fragmentsOf(aliceRoot, HOST_E)).find((r) => r.doc_id === post).title,
                "dark-edit, revised",
                "and Dana's stored copy is the new one, not just her feed row's title"
            );
        });

        it("a takedown reaches the fourth hop after the author goes dark", async () => {
            // The hardest direction, and the one an author most needs to work: a retraction has to
            // outrun its own author's disappearance. Bob holds Alice's chain and so can say `Gone`
            // on her behalf; Cleo, who holds no chain at all, can only pass on the TOMBSTONE - and
            // that memo is the sole thing Dana can ever hear it from once Alice is unreachable.
            const { post } = await seed("dark-delete");

            await unplug(HOST, { alpns: ["fragment"] });
            const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, { method: "DELETE" });
            assert.equal(down.status, 200, await down.text());

            assert.ok(
                await settle(async () => {
                    const gone = !(await feedOf(cleoRoot, HOST_C)).some((r) => r.doc_id === post);
                    const entombed = (await tombstonesOf(aliceRoot, HOST_C)).some(
                        (r) => r.doc_id === post
                    );
                    return gone && entombed ? true : null;
                }),
                "Cleo heard `Gone` from Bob, who holds the author's chain - and kept the fact"
            );

            await unplug(HOST);
            assert.ok(
                await settle(async () => {
                    return (await feedOf(danaRoot, HOST_E)).some((r) => r.doc_id === post)
                        ? null
                        : true;
                }),
                "the takedown reached the fourth hop with the author's node dark"
            );
            assert.equal(
                (await fragmentsOf(aliceRoot, HOST_E)).filter((r) => r.doc_id === post).length,
                0,
                "Dana dropped the words"
            );
            const danaTomb = (await tombstonesOf(aliceRoot, HOST_E)).filter(
                (r) => r.doc_id === post
            );
            assert.equal(danaTomb.length, 1, "and kept the fact, so a fifth hop could still be told");
            // The strongest form of the whole slice's claim: Dana's proof arrived through Cleo,
            // a node that never held Alice's chain - the author's signature crossed a relay that
            // could not have minted it, while the author was unreachable.
            assert.ok(
                danaTomb[0].proof_bytes > 0,
                "and the fact at the deepest hop is the author's signed word, relayed intact"
            );
        });
    });

    /*
        The delete travelling forward is only half of "speech deletes". The other half is that it
        has to STAY deleted at a node that already heard it - and every test above walks the
        cascade in one direction, through a network where everyone hears in order.

        Real networks do not do that. A sharer who was asleep, or slow, or partitioned during the
        takedown wakes up still holding the words and still pointing at them, and offers them to a
        reader who has already buried the thing. The reader's tombstone is the only thing in the
        system that knows better.
    */
    describe("a document that was buried stays buried", function () {
        before(() => setLane("fast"));
        after(() => setLane("default"));

        // Two nodes get partitioned here, so both come back. Belt; roothooks is the braces.
        afterEach(async () => {
            await plugIn(HOST);
            await plugIn(HOST_C);
        });

        it("a stale sharer cannot resurrect a document its reader has entombed", async () => {
            const { post } = await seed("revenant");

            // The stale sharer, modelled precisely: Cleo's OUTBOUND fragment door shuts, so no
            // revalidation can ever tell her the post died - "silence preserves" keeps her copy
            // exactly as it should. Her inbound door stays open, so she will still hand it to
            // anyone who asks. That asymmetry is the whole population this test is about, and it
            // is why the gate takes a direction.
            await unplug(HOST_C, { alpns: ["fragment"], direction: "outbound" });

            const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, { method: "DELETE" });
            assert.equal(down.status, 200, await down.text());

            assert.ok(
                await settle(async () => {
                    const gone = !(await feedOf(danaRoot, HOST_E)).some((r) => r.doc_id === post);
                    const entombed = (await tombstonesOf(aliceRoot, HOST_E)).some(
                        (r) => r.doc_id === post
                    );
                    return gone && entombed ? true : null;
                }),
                "Dana heard the takedown and buried it"
            );

            // The precondition that makes the rest mean anything: Cleo genuinely never heard.
            assert.ok(
                (await fragmentsOf(aliceRoot, HOST_C)).some((r) => r.doc_id === post),
                "precondition: the stale sharer still holds the words she was never told about"
            );

            // And now the author cannot speak either. Without this, Dana's next sweep would ask
            // Alice, hear `Gone` a second time and quietly re-bury it - so the test would pass on
            // the author's availability rather than on Dana's memory, which is the opposite of
            // what it claims. From here, Dana's tombstone is the only thing standing.
            await unplug(HOST, { alpns: ["fragment"] });

            const again = await cleo(`api/identity/${cleoRoot}/rebroadcasts`, {
                method: "POST",
                body: JSON.stringify({ author: aliceRoot, doc_id: post }),
            });
            assert.equal(again.status, 200, await again.text());

            // Several sweeps' worth: the fold, the fetch and the journal each get many chances.
            await new Promise((r) => setTimeout(r, 8000));

            // All three facts in one assertion, on purpose: they fail in different combinations
            // and the combination is the diagnosis. A fragment back WITHOUT the feed row means
            // Dana is silently serving a corpse to a fifth hop; the feed row back as well means
            // a deleted post is on a reader's screen. Asserting them one at a time would report
            // whichever came first and hide the rest.
            assert.deepEqual(
                {
                    knows_it_is_dead:
                        (await tombstonesOf(aliceRoot, HOST_E)).filter((r) => r.doc_id === post)
                            .length === 1,
                    took_the_words_back:
                        (await fragmentsOf(aliceRoot, HOST_E)).filter((r) => r.doc_id === post)
                            .length > 0,
                    back_in_her_feed: (await feedOf(danaRoot, HOST_E)).some(
                        (r) => r.doc_id === post
                    ),
                },
                { knows_it_is_dead: true, took_the_words_back: false, back_in_her_feed: false },
                "a tombstone must outrank a sharer who never heard about the deletion"
            );
        });
    });
});
