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

// What a reader's BROWSER sees: the anonymous body route on the reader's own node - the exact
// URL PostEntry fetches. Added 2026-08-14, after months of green runs proved the database and
// nobody ever asked the HTTP surface: every assertion below the chain (C, D) held verified
// entries and healed blobs behind a route that answered "nothing of theirs is held here".
// The end device fetching the words IS the feature; the tables are how.
const servedBody = async (author, post, host) => {
    const res = await makeFetch(host)(`id/${author}/docs/${post}/body`);
    return res.status === 200 ? res.text() : null;
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
        assert.ok(
            await settle(async () => {
                const body = await servedBody(aliceRoot, post, HOST_C);
                return body && body.includes(title) ? true : null;
            }),
            `seed(${title}): Cleo's own node serves the words to her browser`
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
        assert.ok(
            await settle(async () => {
                const body = await servedBody(aliceRoot, post, HOST_E);
                return body && body.includes(label) ? true : null;
            }),
            `seed(${label}): the end device serves the words - the pipeline reaches the screen`
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
        assert.ok(
            await settle(async () => {
                const body = await servedBody(aliceRoot, post, HOST_E);
                return body && body.includes("revised") ? true : null;
            }),
            "and the SERVED words at the end device are the revision, not a stale blob"
        );
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
            // And her BROWSER can read them, from her own node, with the author dark: the
            // whole point of holding a copy is that the screen shows it when nobody answers.
            assert.ok(
                await settle(async () => {
                    const body = await servedBody(aliceRoot, post, HOST_E);
                    return body && body.includes("dark-serve") ? true : null;
                }),
                "the words are served to the end device while the author is unreachable"
            );
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

    /*
        The retraction cursor: "what died since N?" asked of a peer, answered with a page of
        signed proofs. The per-document sweep revalidates one dial at a time behind a politeness
        cap, so deletion latency used to grow linearly with the shelf; the cursor covers a peer's
        every death in one ask. These tests park the per-document queue entirely
        (`/test/revalidation` mode "none") before killing anything - so whatever arrives
        afterwards provably came by the batch, not the queue.
    */
    describe("the death cursor: one ask covers the shelf", function () {
        const setLaneOn = async (host, mode) => {
            const res = await makeFetch(host)("test/revalidation", {
                method: "POST",
                body: JSON.stringify({ mode }),
            });
            assert.equal(res.status, 200, `setting revalidation mode on ${host}`);
        };
        const reapOn = async (host) => {
            const res = await makeFetch(host)("test/reap", { method: "POST" });
            assert.equal(res.status, 200, `ringing the reap on ${host}`);
        };

        afterEach(async () => {
            await setLaneOn(HOST_C, "default");
            await setLaneOn(HOST_E, "default");
            await plugIn(HOST);
        });

        it("three deletions arrive by the batch, not by the queue", async () => {
            const seeded = [];
            for (const title of ["reaped-one", "reaped-two", "reaped-three"]) {
                seeded.push((await seedToCleo(title)).post);
            }

            // Park Cleo's per-document revalidation BEFORE anything dies: from here, her only
            // road to a deletion is the cursor.
            await setLaneOn(HOST_C, "none");
            for (const post of seeded) {
                const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, {
                    method: "DELETE",
                });
                assert.equal(down.status, 200, await down.text());
            }

            // Bob holds Alice's chain, so his death log grows by the fold's mirror - the rows
            // Cleo's one ask will read.
            assert.ok(
                await settle(async () => {
                    const rows = await tombstonesOf(aliceRoot, HOST_B);
                    return seeded.every((p) => rows.some((r) => r.doc_id === p)) ? true : null;
                }),
                "Bob's log carries all three deaths, proofs attached"
            );

            await reapOn(HOST_C);
            const tombs = (await tombstonesOf(aliceRoot, HOST_C)).filter((r) =>
                seeded.includes(r.doc_id)
            );
            assert.equal(tombs.length, 3, "one ask buried all three - no per-document dials ran");
            assert.ok(
                tombs.every((r) => r.proof_bytes > 0),
                "each with the author's signed word for it"
            );
            for (const post of seeded) {
                assert.ok(
                    !(await feedOf(cleoRoot, HOST_C)).some((r) => r.doc_id === post),
                    "and the feed rows went with them"
                );
            }
        });

        it("a death you never held is not your funeral", async () => {
            // Cleo holds something of Alice's via Bob, so Bob is a peer her reap will ask.
            await seedToCleo("reap-bystander");

            // A post that reaches Bob's feed but is never SHARED - Cleo never holds it.
            const made = await (
                await alice(`api/identity/${aliceRoot}/docs`, {
                    method: "POST",
                    body: JSON.stringify({
                        title: "unshared",
                        body: "unshared: the words",
                        format: "plaintext",
                    }),
                })
            ).json();
            const pub = await alice(`api/identity/${aliceRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
            });
            const post = JSON.parse(await pub.text()).post_id;
            const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, {
                method: "DELETE",
            });
            assert.equal(down.status, 200, await down.text());

            assert.ok(
                await settle(async () => {
                    const rows = await tombstonesOf(aliceRoot, HOST_B);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }),
                "Bob's log carries the death"
            );

            await reapOn(HOST_C);
            // The reap consumed Bob's log - the cursor moved - and still kept nothing: a log
            // names every death its keeper heard, and burying them all would grow the
            // forever-set with every deletion anyone ever relayed, about documents never held.
            const { rows: cursors } = await sql(
                `SELECT cursor FROM death_cursors WHERE origin_root = '${bobRoot}'`,
                HOST_C
            );
            assert.ok(
                cursors.length === 1 && cursors[0].cursor > 0,
                "the cursor advanced past it"
            );
            assert.ok(
                !(await tombstonesOf(aliceRoot, HOST_C)).some((r) => r.doc_id === post),
                "no tombstone grew for a document Cleo never carried"
            );
        });

        it("the fourth hop hears the batch, with the author dark", async () => {
            const { post } = await seed("reap-depth");

            await setLaneOn(HOST_C, "none");
            await setLaneOn(HOST_E, "none");
            // Her fragment door first - every arrival after this is provably second-hand -
            // then the takedown, then full darkness before the deep hops move.
            await unplug(HOST, { alpns: ["fragment"] });
            const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, {
                method: "DELETE",
            });
            assert.equal(down.status, 200, await down.text());
            assert.ok(
                await settle(async () => {
                    const rows = await tombstonesOf(aliceRoot, HOST_B);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }),
                "Bob's log carries the death"
            );
            await unplug(HOST);

            await reapOn(HOST_C); // Cleo reads Bob's log
            await reapOn(HOST_E); // Dana reads Cleo's - rows Cleo just buried, proofs relayed
            const danaTomb = (await tombstonesOf(aliceRoot, HOST_E)).filter(
                (r) => r.doc_id === post
            );
            assert.equal(danaTomb.length, 1, "two asks walked the death to the fourth hop");
            assert.ok(
                danaTomb[0].proof_bytes > 0,
                "with the unreachable author's own signature intact at the deepest hop"
            );
            assert.ok(
                !(await feedOf(danaRoot, HOST_E)).some((r) => r.doc_id === post),
                "and out of Dana's feed"
            );
        });

    });

    /*
        The implicit rebroadcast: a share covers the post AS SEEN - one pointer, one budget,
        one renderable whole. The post's signed header names what it embeds (`refs`), so a
        post fragment's arrival obliges the media too, from the same origin, and a post
        fragment's death releases it (the cover refcount). Real bytes end to end: a webp
        through ingest, the bake minting the public twin, the twin riding the tree, and the
        reader's BROWSER getting the image from the reader's own node.
    */
    describe("the image rides the share", function () {
        const fs = require("node:fs");
        const path = require("node:path");
        const webp = fs.readFileSync(
            path.join(__dirname, "..", "..", "..", "sample_media", "its_webp.webp")
        );

        it("a shared post's image travels, serves, and dies with it", async function () {
            // 1. A real image through the ingest door, waited to readiness.
            const up = await alice(
                `api/identity/${aliceRoot}/docs/binary?title=cat&parents=`,
                { method: "POST", body: webp }
            );
            const upText = await up.text();
            // 200 or 202: the door answers with the doc id while the transcode runs, and the
            // poll below is what waits for readiness either way.
            assert.ok(up.status === 200 || up.status === 202, upText);
            const mediaId = JSON.parse(upText).doc_id;
            assert.ok(mediaId, upText);
            assert.ok(
                await settle(async () => {
                    const r = await alice(`api/identity/${aliceRoot}/docs/${mediaId}`);
                    return r.status === 200 ? true : null;
                }),
                "the upload transcoded and the private media doc exists"
            );

            // 2. A note embedding it, published - the bake mints the public twin and the
            //    signed header's refs name it.
            const made = await (
                await alice(`api/identity/${aliceRoot}/docs`, {
                    method: "POST",
                    body: JSON.stringify({
                        title: "cat post",
                        body: `behold:\n\n![cat](/api/identity/${aliceRoot}/docs/${mediaId}/body/cat.webp)\n`,
                        format: "marquee",
                    }),
                })
            ).json();
            const pub = await alice(`api/identity/${aliceRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
            });
            const pubText = await pub.text();
            assert.equal(pub.status, 200, pubText);
            const post = JSON.parse(pubText).post_id;
            assert.ok(post, `the private twin bakes inline: ${pubText}`);

            // 3. Bob shares; the post reaches Cleo as a fragment, words servable (the
            //    established claims), and the SERVED body names the public twin.
            assert.ok(
                await settle(async () => {
                    const rows = await feedOf(bobRoot, HOST_B);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }),
                "the post reached Bob"
            );
            const bobShared = await bob(`api/identity/${bobRoot}/rebroadcasts`, {
                method: "POST",
                body: JSON.stringify({ author: aliceRoot, doc_id: post }),
            });
            assert.equal(bobShared.status, 200, await bobShared.text());
            const served = await settle(async () => {
                const body = await servedBody(aliceRoot, post, HOST_C);
                return body && body.includes("/docs/") ? body : null;
            });
            assert.ok(served, "Cleo's node serves the shared post's words");
            const twin = (served.match(/\/docs\/([0-9a-f]{32})\/body/) || [])[1];
            assert.ok(twin, `the served body names the baked twin: ${served}`);
            assert.notEqual(twin, post, "the twin is its own public document");

            // 4. The implicit rebroadcast: the twin's FRAGMENT arrived with the post's, and
            //    the IMAGE BYTES serve from Cleo's own node - the reader's renderer asks this
            //    exact URL.
            assert.ok(
                await settle(async () => {
                    const rows = await fragmentsOf(aliceRoot, HOST_C);
                    return rows.some((r) => r.doc_id === twin) ? true : null;
                }),
                "the media twin rode the share as its own fragment"
            );
            assert.ok(
                await settle(async () => {
                    const res = await makeFetch(HOST_C)(`id/${aliceRoot}/docs/${twin}/body`);
                    return res.status === 200 ? true : null;
                }),
                "and the image bytes serve from Cleo's node, to Cleo's browser"
            );

            // 5. The fourth hop: Cleo shares onward; Dana's node ends up serving the image
            //    too, having heard of it only through the tree.
            const onward = await cleo(`api/identity/${cleoRoot}/rebroadcasts`, {
                method: "POST",
                body: JSON.stringify({ author: aliceRoot, doc_id: post }),
            });
            assert.equal(onward.status, 200, await onward.text());
            assert.ok(
                await settle(async () => {
                    const res = await makeFetch(HOST_E)(`id/${aliceRoot}/docs/${twin}/body`);
                    return res.status === 200 ? true : null;
                }),
                "the image serves at the deepest hop"
            );

            // The twin's BYTES, by hash, before anything dies - and a control: some other
            // live fragment's body, which the reaper must NOT touch.
            const { rows: tw } = await sql(
                `SELECT hex(body_hash) AS h FROM fragments WHERE author_root = '${aliceRoot}' AND doc_id = '${twin}'`,
                HOST_C
            );
            const twinBlob = tw[0].h.toLowerCase();
            const { rows: ctl } = await sql(
                `SELECT hex(body_hash) AS h FROM fragments WHERE author_root = '${aliceRoot}' AND doc_id NOT IN ('${post}', '${twin}') LIMIT 1`,
                HOST_C
            );
            const controlBlob = ctl[0].h.toLowerCase();
            const blobAt = async (host, hash) => {
                const res = await makeFetch(host)(`test/blob/${hash}`);
                return res.status === 200 ? (await res.json()).present : null;
            };
            assert.equal(await blobAt(HOST_C, twinBlob), true, "precondition: the image bytes are held");

            // 6. The takedown: the post dies, and the image fragment - covered by nothing
            //    else - goes with it. The cover refcount running at every hop.
            const down = await alice(`api/identity/${aliceRoot}/posts/${post}`, {
                method: "DELETE",
            });
            assert.equal(down.status, 200, await down.text());
            for (const [who, host] of [["Cleo", HOST_C], ["Dana", HOST_E]]) {
                assert.ok(
                    await settle(async () => {
                        const rows = await fragmentsOf(aliceRoot, host);
                        const postGone = !rows.some((r) => r.doc_id === post);
                        const twinGone = !rows.some((r) => r.doc_id === twin);
                        return postGone && twinGone ? true : null;
                    }),
                    `${who} dropped the post AND the image it alone justified`
                );
            }

            // 7. And the BYTES follow: the rows died above, so the next reaper round (2s on
            //    the rig) collects the blobs nothing references any more - the "clear deleted
            //    media from the intermediary filesystems" half. The control blob, referenced
            //    by a live fragment, must survive every one of those rounds.
            assert.ok(
                await settle(async () => {
                    return (await blobAt(HOST_C, twinBlob)) === false ? true : null;
                }),
                "the image's bytes were reaped from Cleo's filesystem"
            );
            assert.equal(
                await blobAt(HOST_C, controlBlob),
                true,
                "and a live document's bytes were not"
            );
        });
    });

    /*
        The edit window: a day to fix your words, after which what you said is what you said
        (width settled 2026-08-15). Runtime-overridable per node (/test/edit-window) because a
        suite cannot wait a day - and set per test, never boot-wide, or every other test's
        posts would freeze mid-flight.
    */
    describe("the edit window: the words settle", function () {
        const setWindowOn = async (host, ms) => {
            const res = await makeFetch(host)("test/edit-window", {
                method: "POST",
                body: JSON.stringify({ ms }),
            });
            assert.equal(res.status, 200, `setting the edit window on ${host || "A"}`);
        };

        afterEach(async () => {
            await setWindowOn(undefined, 0);
            await setWindowOn(HOST_C, 0);
        });

        it("a settled post refuses the edit at the author's own door", async () => {
            const { post, draft, version } = await seedToCleo("settles");
            await setWindowOn(undefined, 2000);
            await new Promise((r) => setTimeout(r, 2600));

            // The private draft edits fine - the window is a PUBLIC posture...
            const put = await alice(`api/identity/${aliceRoot}/docs/${draft}`, {
                method: "PUT",
                body: JSON.stringify({
                    title: "settles, too late",
                    body: "settles, too late: the words",
                    parents: [version],
                    format: "plaintext",
                }),
            });
            assert.equal(put.status, 200, await put.text());

            // ...and re-publication is where the freeze speaks, with words, not a shrug.
            const rep = await alice(`api/identity/${aliceRoot}/docs/${draft}/publish`, {
                method: "POST",
            });
            assert.equal(rep.status, 400, "past the window, the publish refuses");
            assert.match(
                await rep.text(),
                /settled/,
                "and says the post has settled rather than failing mutely"
            );

            // The published words never moved.
            const body = await servedBody(aliceRoot, post, HOST_C);
            assert.ok(body && body.includes("settles: the words"), "what was said is what was said");
        });

        it("a frozen fragment leaves the sweep forever", async () => {
            const { post } = await seedToCleo("freezes");
            const checkedOf = async () => {
                const { rows } = await sql(
                    `SELECT checked_ms FROM fragments WHERE author_root = '${aliceRoot}' AND doc_id = '${post}'`,
                    HOST_C
                );
                return rows.length ? rows[0].checked_ms : null;
            };

            // First, prove the sweep is alive FOR THIS ROW: its stamp advances while young.
            const first = await checkedOf();
            assert.ok(first, "the fragment is on Cleo's shelf");
            assert.ok(
                await settle(async () => {
                    const now = await checkedOf();
                    return now > first ? true : null;
                }),
                "in-window, the sweep revalidates the fragment"
            );

            // Freeze it (the post's genesis is already seconds old; a 1s window is past), and
            // the stamp stops forever - the sweep no longer visits, which is the whole
            // archive-costs-nothing claim in one column.
            await setWindowOn(HOST_C, 1000);
            const frozen = await checkedOf();
            await new Promise((r) => setTimeout(r, 5000));
            assert.equal(
                await checkedOf(),
                frozen,
                "past the window, the sweep never visits the fragment again"
            );
        });
    });

    /*
        Multi-origin resilience: the row remembers ONE origin (first server wins), the
        feed_shares ledger knows every sharer a local reader follows - and until 2026-08-15
        only the reap ever consulted the ledger. These tests are built on the cases where a
        second sharer's own pointer CANNOT paper over the gap (dual-follow self-heals the
        initial fetch through existing machinery): revalidation of edits, and blob healing.

        The per-ALPN gate is what makes each claim a mechanism assertion rather than an
        outcome: with the author's fragment door and the recorded origin both provably dark,
        the second sharer is the only body in the universe that can carry the goods.
    */
    describe("any sharer will do: the ledger outlives the recorded origin", function () {
        this.timeout(1200000);
        const fs = require("node:fs");
        const path = require("node:path");
        const webp = fs.readFileSync(
            path.join(__dirname, "..", "..", "..", "sample_media", "its_webp.webp")
        );

        let ally, allyRoot, bo, boRoot, sam, samRoot, rae, raeRoot;

        before(async function () {
            // Two sharers on DIFFERENT nodes - or dark-Bob is dark-Sam - and a reader who
            // follows both for rebroadcasts.
            ally = await makeUserFetch({ prefix: "morigally" });
            allyRoot = (await (await ally("api/identity", { method: "POST" })).json()).root_pubkey;
            await ally(`api/identity/${allyRoot}/serve`, { method: "POST" });
            const viaAlly = await base58(ally);

            bo = await makeUserFetch({ prefix: "morigbo", host: HOST_B });
            boRoot = (await (await bo("api/identity", { method: "POST" })).json()).root_pubkey;
            await bo(`api/identity/${boRoot}/serve`, { method: "POST" });
            const viaBo = await base58(bo);

            sam = await makeUserFetch({ prefix: "morigsam", host: HOST_C });
            samRoot = (await (await sam("api/identity", { method: "POST" })).json()).root_pubkey;
            await sam(`api/identity/${samRoot}/serve`, { method: "POST" });
            const viaSam = await base58(sam);

            rae = await makeUserFetch({ prefix: "morigrae", host: HOST_E });
            raeRoot = (await (await rae("api/identity", { method: "POST" })).json()).root_pubkey;

            if ((await bo(`api/id/${allyRoot}/profile?via=${viaAlly}`)).status !== 200) this.skip();
            await dial(bo, boRoot, allyRoot, "interest", "high");
            if ((await sam(`api/id/${allyRoot}/profile?via=${viaAlly}`)).status !== 200) this.skip();
            await dial(sam, samRoot, allyRoot, "interest", "high");
            if ((await rae(`api/id/${boRoot}/profile?via=${viaBo}`)).status !== 200) this.skip();
            await dial(rae, raeRoot, boRoot, "interest_rebroadcasts", "high");
            if ((await rae(`api/id/${samRoot}/profile?via=${viaSam}`)).status !== 200) this.skip();
            await dial(rae, raeRoot, samRoot, "interest_rebroadcasts", "high");
        });

        const setLaneOn = async (host, mode) => {
            const res = await makeFetch(host)("test/revalidation", {
                method: "POST",
                body: JSON.stringify({ mode }),
            });
            assert.equal(res.status, 200, `setting revalidation mode on ${host}`);
        };

        afterEach(async () => {
            await plugIn(HOST);
            await plugIn(HOST_B);
            await plugIn(HOST_C);
            await setLaneOn(HOST_E, "default");
        });

        /// Publish (optionally with an embedded image), have BOB share first - settled, so the
        /// fragment's recorded origin is deterministically his - then SAM. Ends by pinning the
        /// premise in SQL: the row remembers one, the ledger knows two. Without that pin the
        /// suite proves nothing - if the origin happened to be Sam, darkening Bob tests the
        /// happy path.
        async function seedDual(title, { image = false } = {}) {
            let body = `${title}: the words`;
            if (image) {
                const up = await ally(
                    `api/identity/${allyRoot}/docs/binary?title=pic&parents=`,
                    { method: "POST", body: webp }
                );
                const upText = await up.text();
                assert.ok(up.status === 200 || up.status === 202, upText);
                const mediaId = JSON.parse(upText).doc_id;
                assert.ok(
                    await settle(async () => {
                        const r = await ally(`api/identity/${allyRoot}/docs/${mediaId}`);
                        return r.status === 200 ? true : null;
                    }),
                    `seedDual(${title}): the upload transcoded`
                );
                body = `${title}: the words\n\n![pic](/api/identity/${allyRoot}/docs/${mediaId}/body/pic.webp)\n`;
            }
            const made = await (
                await ally(`api/identity/${allyRoot}/docs`, {
                    method: "POST",
                    body: JSON.stringify({
                        title,
                        body,
                        format: image ? "marquee" : "plaintext",
                    }),
                })
            ).json();
            const pub = await ally(`api/identity/${allyRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
            });
            const pubText = await pub.text();
            assert.equal(pub.status, 200, pubText);
            const post = JSON.parse(pubText).post_id;

            for (const [who, root, host] of [["Bo", boRoot, HOST_B], ["Sam", samRoot, HOST_C]]) {
                assert.ok(
                    await settle(async () => {
                        const rows = await feedOf(root, host);
                        return rows.some((r) => r.doc_id === post) ? true : null;
                    }),
                    `seedDual(${title}): the post reached ${who}'s chain copy`
                );
            }

            const boShared = await bo(`api/identity/${boRoot}/rebroadcasts`, {
                method: "POST",
                body: JSON.stringify({ author: allyRoot, doc_id: post }),
            });
            assert.equal(boShared.status, 200, await boShared.text());
            assert.ok(
                await settle(async () => {
                    const rows = await fragmentsOf(allyRoot, HOST_E);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }),
                `seedDual(${title}): Rae holds the fragment via Bo`
            );

            const samShared = await sam(`api/identity/${samRoot}/rebroadcasts`, {
                method: "POST",
                body: JSON.stringify({ author: allyRoot, doc_id: post }),
            });
            assert.equal(samShared.status, 200, await samShared.text());
            assert.ok(
                await settle(async () => {
                    const { rows } = await sql(
                        `SELECT via_root FROM feed_shares WHERE author_root = '${allyRoot}' AND doc_id = '${post}'`,
                        HOST_E
                    );
                    const vias = rows.map((r) => r.via_root);
                    return vias.includes(boRoot) && vias.includes(samRoot) ? true : null;
                }),
                `seedDual(${title}): the ledger knows both sharers`
            );

            // THE PREMISE, pinned: one recorded origin (Bo, deterministically - he served
            // first), two known sharers.
            const { rows: frows } = await sql(
                `SELECT origin_root FROM fragments WHERE author_root = '${allyRoot}' AND doc_id = '${post}'`,
                HOST_E
            );
            assert.equal(frows[0].origin_root, boRoot, "the row remembers exactly one origin");

            return { post, draft: made.doc_id, version: made.version };
        }

        it("an edit arrives from the OTHER sharer when the recorded origin is dark", async () => {
            const { post, draft, version } = await seedDual("anyorigin-edit");
            // Words settled at Rae first, so the edit assertion below is a CHANGE, not a first
            // arrival.
            assert.ok(
                await settle(async () => {
                    const body = await servedBody(allyRoot, post, HOST_E);
                    return body && body.includes("anyorigin-edit") ? true : null;
                }),
                "precondition: the original words serve at Rae's node"
            );

            // The choreography that forces the mechanism: the author's FRAGMENT door shuts
            // (her sync door stays open - Sam's chain copy must keep updating), the recorded
            // origin goes fully dark. Sam is now the only body in the universe holding v2
            // that Rae can reach.
            await unplug(HOST, { alpns: ["fragment"] });
            await unplug(HOST_B);

            const put = await ally(`api/identity/${allyRoot}/docs/${draft}`, {
                method: "PUT",
                body: JSON.stringify({
                    title: "anyorigin-edit, revised",
                    body: "anyorigin-edit, revised: the words",
                    parents: [version],
                    format: "plaintext",
                }),
            });
            assert.equal(put.status, 200, await put.text());
            const rep = await ally(`api/identity/${allyRoot}/docs/${draft}/publish`, {
                method: "POST",
            });
            assert.equal(rep.status, 200, await rep.text());

            assert.ok(
                await settle(async () => {
                    const rows = await fragmentsOf(allyRoot, HOST_E);
                    const r = rows.find((x) => x.doc_id === post);
                    return r && r.title.includes("revised") ? true : null;
                }),
                "the revision reached Rae - only Sam could have carried it"
            );
            assert.ok(
                await settle(async () => {
                    const body = await servedBody(allyRoot, post, HOST_E);
                    return body && body.includes("revised") ? true : null;
                }),
                "and the revised WORDS serve - the blob walked the same fallback"
            );
        });

        it("the words and the image arrive when the origin dies between header and body", async () => {
            // Bo's BLOB door shuts before he shares: every entry arrives from him (fragment
            // ALPN, open), every byte is refused (blob ALPN) - the wants ledger fills with a
            // candidate that then goes fully dark. Sam holds every blob one hop away.
            await unplug(HOST_B, { alpns: ["blob"] });
            const { post } = await seedDual("anyorigin-bytes", { image: true });
            await unplug(HOST_B);

            const served = await settle(async () => {
                const body = await servedBody(allyRoot, post, HOST_E);
                return body && body.includes("anyorigin-bytes") ? body : null;
            });
            assert.ok(served, "the post's words healed from the other sharer");
            const twin = (served.match(/\/docs\/([0-9a-f]{32})\/body/) || [])[1];
            assert.ok(twin, `the served body names the twin: ${served}`);
            assert.ok(
                await settle(async () => {
                    const res = await makeFetch(HOST_E)(`id/${allyRoot}/docs/${twin}/body`);
                    return res.status === 200 ? true : null;
                }),
                "and the image's bytes healed from the other sharer too"
            );
        });

        it("an old version cannot roll a newer one back", async () => {
            /*
                The out-of-order construction, deterministic by ALPN: Bo's SYNC door freezes
                his chain knowledge at v2 while his FRAGMENT door keeps answering; the world
                moves to v3; the author goes dark; Rae's revalidation now consults a fossil
                every beat. Today `remember` re-stores whatever the last answerer served -
                last-write-by-ARRIVAL - so v2 overwrites v3 within a beat or two, and with
                heterogeneous sharers the copy can oscillate v2/v3 by whoever answers first.
                The desired property, asserted and RED until the ordering fix lands: an
                arriving version older by the author's own numbers changes nothing.
            */
            // Fast lane on Rae's node: the rig boots tree-only, where she could never reach
            // v3 at all with her origin fossilized - which the pre-fix run demonstrated by
            // failing at the ARRIVAL stage. The rollback claim needs v3 in hand first.
            await setLaneOn(HOST_E, "fast");
            const { post, draft, version } = await seedDual("rollback-one");

            // v2, converged everywhere - including Bo, whose copy is about to fossilize.
            const put2 = await ally(`api/identity/${allyRoot}/docs/${draft}`, {
                method: "PUT",
                body: JSON.stringify({
                    title: "rollback-two",
                    body: "rollback-two: the words",
                    parents: [version],
                    format: "plaintext",
                }),
            });
            const put2Text = await put2.text();
            assert.equal(put2.status, 200, put2Text);
            const v2 = JSON.parse(put2Text).version;
            const rep2 = await ally(`api/identity/${allyRoot}/docs/${draft}/publish`, {
                method: "POST",
            });
            assert.equal(rep2.status, 200, await rep2.text());
            for (const [who, root, host] of [["Bo", boRoot, HOST_B], ["Rae", raeRoot, HOST_E]]) {
                assert.ok(
                    await settle(async () => {
                        const rows = await feedOf(root, host);
                        const r = rows.find((x) => x.doc_id === post);
                        return r && r.title === "rollback-two" ? true : null;
                    }),
                    `v2 reached ${who}`
                );
            }

            // Bo's chain knowledge fossilizes: sync refused, fragment door still answering.
            await unplug(HOST_B, { alpns: ["sync"] });

            // v3, which Bo can never learn of.
            const put3 = await ally(`api/identity/${allyRoot}/docs/${draft}`, {
                method: "PUT",
                body: JSON.stringify({
                    title: "rollback-three",
                    body: "rollback-three: the words",
                    parents: [v2],
                    format: "plaintext",
                }),
            });
            assert.equal(put3.status, 200, await put3.text());
            const rep3 = await ally(`api/identity/${allyRoot}/docs/${draft}/publish`, {
                method: "POST",
            });
            assert.equal(rep3.status, 200, await rep3.text());
            assert.ok(
                await settle(async () => {
                    const rows = await fragmentsOf(allyRoot, HOST_E);
                    const r = rows.find((x) => x.doc_id === post);
                    return r && r.title === "rollback-three" ? true : null;
                }),
                "Rae reached v3 straight from the author"
            );
            // The staleness pin: Bo provably still believes v2.
            const boRows = await feedOf(boRoot, HOST_B);
            assert.equal(
                boRows.find((x) => x.doc_id === post).title,
                "rollback-two",
                "precondition: the fossil is a fossil"
            );

            // The author goes dark; the fossil answers every revalidation from here.
            await unplug(HOST, { alpns: ["fragment"] });

            // The property: across many sweep beats of Bo serving v2, Rae's copy never goes
            // backward. Sampled, not settled - the failure mode IS a transition, and one
            // sighting of v2 is the defect demonstrated.
            for (let i = 0; i < 12; i++) {
                await new Promise((r) => setTimeout(r, 700));
                const rows = await fragmentsOf(allyRoot, HOST_E);
                const r = rows.find((x) => x.doc_id === post);
                assert.ok(r, "the fragment stands throughout");
                assert.equal(
                    r.title,
                    "rollback-three",
                    `sample ${i}: an old version arriving late must change nothing - ` +
                        "the author's own numbers order the author's own document"
                );
            }
        });

        it("every source dark is silence, not loss - and not overreach", async () => {
            const { post } = await seedDual("anyorigin-silence");
            assert.ok(
                await settle(async () => {
                    const body = await servedBody(allyRoot, post, HOST_E);
                    return body && body.includes("anyorigin-silence") ? true : null;
                }),
                "precondition: fully arrived before the world goes dark"
            );
            const before = (await fragmentsOf(allyRoot, HOST_E)).find((r) => r.doc_id === post);

            await unplug(HOST, { alpns: ["fragment"] });
            await unplug(HOST_B);
            await unplug(HOST_C);
            // Many sweep beats: every candidate the fallback walk could try refuses.
            await new Promise((r) => setTimeout(r, 8000));

            const after = (await fragmentsOf(allyRoot, HOST_E)).find((r) => r.doc_id === post);
            assert.ok(after, "the fragment stands");
            assert.equal(after.version, before.version, "same version - exhaustion is not news");
            assert.equal(
                (await tombstonesOf(allyRoot, HOST_E)).filter((r) => r.doc_id === post).length,
                0,
                "and silence buried nothing"
            );
        });
    });

    /*
        The last-stop hole (design conversation 2026-08-15): a persona's own nodes are not
        part of the share tree. Node A holds a share complete - chain, fragment, blobs, all
        behind doors that answer anyone - and when the sharer and author go dark for good,
        node B's candidate lists (sharer-chain sync, the fragment walk, blob healing) all
        resolve to the departed. The sibling is never asked. This test asserts the property
        the cohort-as-candidate slice will make true: a share held only by a sibling reaches
        the waking node.

        RED as of 2026-08-15, demonstrated live before being skipped (a standing red suite
        blocks every interleaved slice - green before forward). UNSKIP THIS as the fix's
        first move; NEXT_STEPS carries the pointer.
    */
    describe.skip("the cohort is part of the tree", function () {
        this.timeout(1200000);

        let author, authorRoot, sharer, sharerRoot, cora, coraRoot;

        before(async function () {
            author = await makeUserFetch({ prefix: "lastauthor" });
            authorRoot = (await (await author("api/identity", { method: "POST" })).json()).root_pubkey;
            await author(`api/identity/${authorRoot}/serve`, { method: "POST" });
            const viaAuthor = await base58(author);

            sharer = await makeUserFetch({ prefix: "lastsharer", host: HOST_B });
            sharerRoot = (await (await sharer("api/identity", { method: "POST" })).json()).root_pubkey;
            await sharer(`api/identity/${sharerRoot}/serve`, { method: "POST" });
            const viaSharer = await base58(sharer);

            cora = await makeUserFetch({ prefix: "lastcora", host: HOST_C });
            coraRoot = (await (await cora("api/identity", { method: "POST" })).json()).root_pubkey;
            await cora(`api/identity/${coraRoot}/serve`, { method: "POST" });

            if ((await sharer(`api/id/${authorRoot}/profile?via=${viaAuthor}`)).status !== 200)
                this.skip();
            await dial(sharer, sharerRoot, authorRoot, "interest", "high");
            if ((await cora(`api/id/${sharerRoot}/profile?via=${viaSharer}`)).status !== 200)
                this.skip();
            await dial(cora, coraRoot, sharerRoot, "interest_rebroadcasts", "high");

            // Cora's SECOND node: a fresh account on echo adopts the persona (the daisychain
            // ceremony), and the ledger sync carries the rebroadcast-follow across - settle
            // until echo's own subscriptions memo knows it, proving the cohort input paths
            // work before any darkness.
            const coraOnE = await makeUserFetch({ prefix: "lastcorae", host: HOST_E });
            const request = await (
                await coraOnE("api/identity/adopt/begin", { method: "POST" })
            ).json();
            const granted = await cora(`api/identity/${coraRoot}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            });
            assert.equal(granted.status, 200, await granted.text());
            assert.ok(
                await settle(async () => {
                    const { rows } = await sql(
                        `SELECT 1 AS ok FROM subscriptions WHERE local_root = '${coraRoot}' AND foreign_root = '${sharerRoot}' AND rebroadcast IS NOT NULL`,
                        HOST_E
                    );
                    return rows.length ? true : null;
                }),
                "the sibling learned the rebroadcast-follow from the synced ledger"
            );
        });

        afterEach(async () => {
            await plugIn(HOST);
            await plugIn(HOST_B);
            await plugIn(HOST_E);
        });

        it("a share held only by a sibling reaches the waking node", async () => {
            // The sibling sleeps through everything.
            await unplug(HOST_E);

            const made = await (
                await author(`api/identity/${authorRoot}/docs`, {
                    method: "POST",
                    body: JSON.stringify({
                        title: "laststop",
                        body: "laststop: the words",
                        format: "plaintext",
                    }),
                })
            ).json();
            const pub = await author(`api/identity/${authorRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
            });
            const pubText = await pub.text();
            assert.equal(pub.status, 200, pubText);
            const post = JSON.parse(pubText).post_id;

            assert.ok(
                await settle(async () => {
                    const rows = await feedOf(sharerRoot, HOST_B);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }),
                "the post reached the sharer"
            );
            const shared = await sharer(`api/identity/${sharerRoot}/rebroadcasts`, {
                method: "POST",
                body: JSON.stringify({ author: authorRoot, doc_id: post }),
            });
            assert.equal(shared.status, 200, await shared.text());

            // The last stop loads up: charlie holds the row, the fragment, the words.
            assert.ok(
                await settle(async () => {
                    const body = await servedBody(authorRoot, post, HOST_C);
                    return body && body.includes("laststop") ? true : null;
                }),
                "the awake node holds and serves the share"
            );

            // The rest of the world leaves, forever.
            await unplug(HOST);
            await unplug(HOST_B);

            // The sibling wakes into a network where its own cohort is the only holder.
            await plugIn(HOST_E);

            // THE PROPERTY: the share reaches the sibling - feed row, fragment, served
            // words - with charlie the only live source. Today every candidate list points
            // at the departed, and this settle times out.
            assert.ok(
                await settle(async () => {
                    const rows = await feedOf(coraRoot, HOST_E);
                    return rows.some((r) => r.doc_id === post) ? true : null;
                }, 160),
                "the share's feed row reached the waking sibling"
            );
            assert.ok(
                await settle(async () => {
                    const body = await servedBody(authorRoot, post, HOST_E);
                    return body && body.includes("laststop") ? true : null;
                }, 80),
                "and the sibling serves the words its cohort preserved"
            );
        });
    });

    describe("the death cursor: the steady state", function () {
        const reapOn = async (host) => {
            const res = await makeFetch(host)("test/reap", { method: "POST" });
            assert.equal(res.status, 200, `ringing the reap on ${host}`);
        };

        it("the steady state is an empty page", async () => {
            await seedToCleo("reap-quiet");
            await reapOn(HOST_C);
            const cursorOf = async () => {
                const { rows } = await sql(
                    `SELECT cursor FROM death_cursors WHERE origin_root = '${bobRoot}'`,
                    HOST_C
                );
                return rows.length ? rows[0].cursor : 0;
            };
            const settled = await cursorOf();
            await reapOn(HOST_C);
            assert.equal(
                await cursorOf(),
                settled,
                "asking again when nothing died moves nothing - the whole argument for cursors"
            );
        });
    });
});
