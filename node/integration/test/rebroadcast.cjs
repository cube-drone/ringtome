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

    The cascade tests - edits, deletes, and their combinations travelling the full share tree -
    live in cascade.cjs, which runs the four-node chain with the author fast-lane disabled. This
    file keeps the share mechanics: the pointer, the cross-node arrival, the dial split, and the
    author's notice.

    The headline case was pending for a while, and why is worth keeping: C cannot journal a row
    for a document she has no copy of, because a feed row carries the title and format and those
    live in A's document. Nothing relays A's shelf to C - sync is per identity, and C subscribes
    to B, not to A. C is supposed to get a FRAGMENT, not a subscription, because a chain pin that
    propagated with viewing would degrade a dense network to every persona synced to every
    computer.

    So the fragment ledger is what makes this pass: C asks B - the ORIGIN, the edge the pointer
    arrived by - for exactly one document, verifies the author's signature and delegation path
    offline, and holds it without ever syncing A.

    Still to come here: the node-death case (kill A and B, assert C still serves from its own
    fragment), which is what turns "C can fetch it" into "the network keeps it alive".
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");


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
        // The PUBLIC document id, which is not the private one: publishing mints a new document
        // on the public lane (`post_id`), and the private draft keeps its own id. Sharing the
        // draft's id asks every origin for a document that exists on nobody's public shelf.
        post = JSON.parse(await published.text()).post_id;
        assert.ok(post, "publish returned a public post id");

        await pullAndFold(HOST_B, aliceRoot);
        assert.ok(
            (await feedOf(bobRoot, HOST_B)).some((r) => r.title === "worth passing on"),
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

    it("a rebroadcast-only follower receives a post from an author they never followed", async () => {
        await pullAndFold(HOST_C, bobRoot);
        const row = (await feedOf(cleoRoot, HOST_C)).find((r) => r.title === "worth passing on");
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
        await beat(HOST_B, "outbox"); // knock again NOW, in case the eager knock raced
        const r = await (await alice(`api/identity/${aliceRoot}/notifications`)).json();
        const items = (r.items || []).filter((i) => i.kind === "rebroadcast");
        assert.ok(items.length, "the author was told their post was shared");
        assert.equal(items[0].author, bobRoot, "by whom");
    });
});
