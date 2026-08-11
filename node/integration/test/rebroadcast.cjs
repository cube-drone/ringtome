/*
    Rebroadcast across three nodes: the shape the whole feature exists for.

        A (host A) posts.        B (host B) follows A, and SHARES one of their posts.
        C (host C) follows B *for rebroadcasts only* - and has never heard of A.

    C must end up with the post in their feed, bylined as arriving via B. That is the entire
    social claim of the feature: **a share reaches people the author cannot reach**, because
    they are following the sharer, not the author.

    This test exists because the first cut of the feed passed every unit test and did nothing
    across nodes. Journaling fired on the shared AUTHOR's public move (which never happens on a
    node that does not hold that author) and in the share ROUTE (which only runs on the sharer's
    own node), so a reader syncing a foreign sharer's pointers journaled nothing at all. Same-node
    sharing worked, which is exactly the case a single-node test would have proven.

    THE HEADLINE CASE IS PENDING, and finding out why was the point of writing this. C cannot
    journal a row for a document she has no copy of: a feed row carries the title, format and
    stamps, and those live in A's document, which C has never fetched. Nothing relays A's shelf
    to C - sync is per identity, and C subscribes to B, not to A. So the cross-node share is
    blocked on the FRAGMENT LEDGER (PROJECT_PLAN, What travels with a share): the document
    fragment, cached with an origin, revalidated along the edge it arrived by.

    That is a design answer, not a bug: the pin is deliberately the sharer's obligation and must
    never propagate with viewing, or a dense network degrades to every persona synced to every
    computer. C is supposed to get a FRAGMENT, not a subscription. It just is not built.

    When it is, the pending test below goes live and this file gains the node-death case - kill
    A and B, assert C still serves - which is the whole acceptance test for that slice.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = async (fn, tries = 100) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

const createDoc = async (fetch, root, title, body) => {
    const r = await (
        await fetch(`api/identity/${root}/docs`, {
            method: "POST",
            body: JSON.stringify({ title, body, format: "plaintext" }),
        })
    ).json();
    return { id: r.doc_id, v: r.version };
};

const dial = (fetcher, mine, theirs, key, value) =>
    fetcher(`api/identity/${mine}/private/kv/contact:${theirs}/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
    });

const feedOf = async (reader, host) => {
    const { rows } = await sql(
        `SELECT author_root, via_root, title FROM feed_journal WHERE reader_root = '${reader}'`,
        host
    );
    return rows;
};

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

(HOST_B && HOST_C ? describe : describe.skip)("a share reaches past the author", function () {
    this.timeout(180000);

    let alice, aliceRoot, bob, bobRoot, cleo, cleoRoot, post;

    before(async function () {
        alice = await makeUserFetch({ prefix: "rbalice" });
        aliceRoot = (await (await alice("api/identity", { method: "POST" })).json()).root_pubkey;
        await alice(`api/identity/${aliceRoot}/serve`, { method: "POST" });
        const viaAlice = await base58(alice);

        bob = await makeUserFetch({ prefix: "rbbob", host: HOST_B });
        bobRoot = (await (await bob("api/identity", { method: "POST" })).json()).root_pubkey;
        await bob(`api/identity/${bobRoot}/serve`, { method: "POST" });
        const viaBob = await base58(bob);

        cleo = await makeUserFetch({ prefix: "rbcleo", host: HOST_C });
        cleoRoot = (await (await cleo("api/identity", { method: "POST" })).json()).root_pubkey;

        // Bob follows Alice the ordinary way - he has to see her post to share it.
        if ((await bob(`api/id/${aliceRoot}/profile?via=${viaAlice}`)).status !== 200) this.skip();
        await dial(bob, bobRoot, aliceRoot, "interest", "high");

        // Cleo follows Bob for REBROADCASTS ONLY. No interest dial: she does not want Bob's own
        // posts, and she has never heard of Alice. This is the relationship under test.
        if ((await cleo(`api/id/${bobRoot}/profile?via=${viaBob}`)).status !== 200) this.skip();
        await dial(cleo, cleoRoot, bobRoot, "interest_rebroadcasts", "high");

        // Alice posts, and it reaches Bob.
        const doc = await createDoc(alice, aliceRoot, "worth passing on", "words from alice");
        const published = await alice(`api/identity/${aliceRoot}/docs/${doc.id}/publish`, {
            method: "POST",
        });
        assert.equal(published.status, 200, await published.text());
        post = doc.id;

        assert.ok(
            await settle(async () => {
                const rows = await feedOf(bobRoot, HOST_B);
                return rows.some((r) => r.title === "worth passing on") ? rows : null;
            }),
            "precondition: the post crossed to Bob, who follows Alice"
        );
    });

    it("the share itself is signed, stamped and queued", async () => {
        const shared = await bob(`api/identity/${bobRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: aliceRoot, doc_id: post, version: "00".repeat(32) }),
        });
        assert.equal(shared.status, 200, await shared.text());
        const listed = await (await bob(`api/identity/${bobRoot}/rebroadcasts`)).json();
        assert.ok(
            listed.items.some((i) => i.doc_id === post && i.author === aliceRoot),
            "the sharer's own list shows what they share"
        );
    });

    // PENDING until the fragment ledger lands - see the header. The assertion is written out
    // rather than described, so turning it on is deleting one line.
    it.skip("a rebroadcast-only follower receives a post from an author they never followed", async () => {
        const row = await settle(async () => {
            const rows = await feedOf(cleoRoot, HOST_C);
            return rows.find((r) => r.title === "worth passing on") || null;
        });
        assert.ok(row, "the shared post reached a reader who follows only the sharer");
        assert.equal(row.author_root, aliceRoot, "credited to its author, not to the sharer");
        assert.equal(row.via_root, bobRoot, "and bylined with who passed it along");
    });

    it("the sharer's own posts stay out of a rebroadcast-only feed", async () => {
        // The dial split, proven from the other side: Cleo asked for what Bob RECOMMENDS, not
        // for what Bob writes. If this ever fails, the two bands have collapsed into one.
        //
        // Honest caveat while the case above is pending: Cleo's feed is empty either way, so
        // this proves absence-from-nothing today. It becomes a real contrast the moment the
        // fragment ledger lets a shared post land beside a withheld one - which is the reason
        // to write it now rather than after.
        const doc = await createDoc(bob, bobRoot, "bobs own musings", "not a recommendation");
        await bob(`api/identity/${bobRoot}/docs/${doc.id}/publish`, { method: "POST" });

        // Give it as long as the assertion above needed to succeed, so this is a real absence
        // rather than a race won by asserting early.
        await new Promise((r) => setTimeout(r, 8000));
        const rows = await feedOf(cleoRoot, HOST_C);
        assert.ok(
            !rows.some((r) => r.title === "bobs own musings"),
            "a rebroadcast band is not a follow"
        );
    });

    it("the author hears about it, across a graph they have no edge in", async () => {
        // Alice does not follow Bob, so the derived fold cannot speak for her: this had to
        // arrive as a delivered envelope through the inbox (notice_kind::REBROADCAST).
        const items = await settle(async () => {
            const r = await (await alice(`api/identity/${aliceRoot}/notifications`)).json();
            const found = (r.items || []).filter((i) => i.kind === "rebroadcast");
            return found.length ? found : null;
        });
        assert.ok(items, "the author was told their post was shared");
        assert.equal(items[0].author, bobRoot, "by whom");
    });
});
