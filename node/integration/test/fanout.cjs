/*
    Fan-out: the moment a persona's public lane moves, readers hear about it - locally as a
    journal row, remotely as a push over the ordinary sync exchange.

    The design being pinned: there is NO notification message anywhere. The push is a sync, the
    receiver's own gate validates what arrives, and the receiver's own journal write is the
    "notification". Ordering and ranking are absent on purpose - the journal is "honest about
    what came" (Journal, then index), and how a feed READS is decided when its reader opens it.
*/
const assert = require("node:assert");
const { sql, HOST_B, HOST_C } = require("./fetch.cjs");
const { makeUserFetch, decodeCode } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");


const journalOf = async (reader, host) => {
    const { rows } = await sql(
        `SELECT author_root, doc_id, title, published_ms, updated_ms, arrived_ms
         FROM feed_journal WHERE reader_root = '${reader}' ORDER BY published_ms`,
        host
    );
    return rows;
};

const follow = (fetcher, mine, theirs, level) =>
    fetcher(`api/identity/${mine}/private/kv/contact:${theirs}/interest`, {
        method: "PUT",
        body: JSON.stringify({ value: String(level) }),
    });

describe("fan-out: the arrival journal", () => {
    let author, authorRoot, reader, readerRoot;

    before(async () => {
        author = await makeUserFetch({ prefix: "fanauthor" });
        authorRoot = (await (await author("api/identity", { method: "POST" })).json()).root_pubkey;
        reader = await makeUserFetch({ prefix: "fanreader" });
        readerRoot = (await (await reader("api/identity", { method: "POST" })).json()).root_pubkey;
    });

    it("a post lands in the journal of a local follower, unasked", async () => {
        await follow(reader, readerRoot, authorRoot, "high");
        // The follow must be in the subscription memo BEFORE the post, or the edge fires into
        // an empty follower list - so ring the reader's fold, which refreshes the memo.
        await beat(undefined, "fold", readerRoot);
        {
            const { rows } = await sql(
                `SELECT 1 FROM subscriptions WHERE local_root = '${readerRoot}'
                 AND foreign_root = '${authorRoot}'`
            );
            assert.ok(rows.length, "the follow reached the memo");
        }

        const d = await (
            await author(`api/identity/${authorRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "First", body: "hello", format: "plaintext" }),
            })
        ).json();
        const pub = await author(`api/identity/${authorRoot}/docs/${d.doc_id}/publish`, {
            method: "POST",
        });
        const postId = JSON.parse(await pub.text()).post_id;

        await beat(undefined, "fold", authorRoot);
        const rows = await journalOf(readerRoot);
        assert.ok(rows.length, "the journal row arrived without the reader doing anything");
        assert.equal(rows[0].author_root, authorRoot);
        assert.equal(rows[0].doc_id, postId, "the PUBLIC post, never the private note");
        assert.equal(rows[0].title, "First");
        assert.ok(rows[0].arrived_ms > 0);
    });

    it("a re-publication updates the row rather than repeating it", async () => {
        const before = await journalOf(readerRoot);
        const note = await (await author(`api/identity/${authorRoot}/docs`)).json();
        const docs = Array.isArray(note) ? note : note.docs || [];
        const mine = docs.find((x) => x.title === "First");
        const detail = await (await author(`api/identity/${authorRoot}/docs/${mine.doc_id}`)).json();
        await author(`api/identity/${authorRoot}/docs/${mine.doc_id}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "First",
                body: "hello, revised",
                format: "plaintext",
                parents: detail.save_parents,
            }),
        });
        await author(`api/identity/${authorRoot}/docs/${mine.doc_id}/publish`, { method: "POST" });

        await beat(undefined, "fold", authorRoot);
        const updated = await journalOf(readerRoot);
        assert.ok(updated[0].updated_ms > before[0].updated_ms, "the row noticed the new words");
        assert.equal(updated.length, before.length, "saying it better is not saying it again");
        assert.equal(updated[0].published_ms, before[0].published_ms, "and it kept its date");
        assert.equal(updated[0].arrived_ms, before[0].arrived_ms, "and its arrival");
    });

    it("'don't show' means it - interest zero journals nothing", async () => {
        const shunner = await makeUserFetch({ prefix: "fanshun" });
        const shunRoot = (await (await shunner("api/identity", { method: "POST" })).json())
            .root_pubkey;
        await follow(shunner, shunRoot, authorRoot, "none");
        await beat(undefined, "fold", shunRoot);
        const d = await (
            await author(`api/identity/${authorRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Second", body: "more", format: "plaintext" }),
            })
        ).json();
        await author(`api/identity/${authorRoot}/docs/${d.doc_id}/publish`, { method: "POST" });
        // The fold beat IS the pass, run to completion - so the shunner's silence below is
        // a decision, not lag. The follower's growth proves the same pass delivered.
        await beat(undefined, "fold", authorRoot);
        assert.ok((await journalOf(readerRoot)).length >= 2, "the real follower's journal grew");
        assert.deepEqual(await journalOf(shunRoot), [], "the zero-interest reader heard nothing");
    });

    it("a NEW follow backfills the author's page - history arrives at follow time", async () => {
        // The author has posted twice already; this reader arrives late. Without backfill,
        // the follow-moment sync receives nothing (nothing moved), and the feed stays empty
        // until the author's NEXT post - the gap the follow itself is supposed to close.
        const late = await makeUserFetch({ prefix: "fanlate" });
        const lateRoot = (await (await late("api/identity", { method: "POST" })).json())
            .root_pubkey;
        await follow(late, lateRoot, authorRoot, "medium");
        await beat(undefined, "fold", lateRoot);
        await beat(undefined, "journal-fill");
        const rows = await journalOf(lateRoot);
        assert.ok(rows.length >= 2, "the existing posts reached the new follower, unprompted");
        assert.deepEqual(
            rows.map((r) => r.title),
            ["First", "Second"],
            "the author's page, in its own order"
        );
        const veteran = await journalOf(readerRoot);
        assert.equal(
            rows[0].published_ms,
            veteran.find((r) => r.title === "First").published_ms,
            "backfilled rows keep the ORIGINAL date - they interleave, not clump at the top"
        );
    });

    it("unfollowing excises their rows - and only theirs", async () => {
        // The reader says something of their own first, so the excision has an exemption to
        // prove: your own posts are in your feed because you are hosted here, not because
        // you follow yourself - unfollowing someone must not touch them.
        const mine = await (
            await reader(`api/identity/${readerRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Mine stays", body: "still here", format: "plaintext" }),
            })
        ).json();
        await reader(`api/identity/${readerRoot}/docs/${mine.doc_id}/publish`, { method: "POST" });
        await beat(undefined, "fold", readerRoot);
        assert.ok(
            (await journalOf(readerRoot)).some((r) => r.title === "Mine stays"),
            "the reader's own post journaled"
        );

        await follow(reader, readerRoot, authorRoot, "none");
        await beat(undefined, "fold", readerRoot);
        const after = await journalOf(readerRoot);
        assert.ok(
            !after.some((r) => r.author_root === authorRoot),
            "the unfollowed author's rows are gone"
        );
        assert.ok(
            after.some((r) => r.title === "Mine stays"),
            "the reader's own post survived the excision"
        );

        // And nothing was lost that anyone owns: a re-follow backfills them right back.
        await follow(reader, readerRoot, authorRoot, "medium");
        await beat(undefined, "fold", readerRoot);
        await beat(undefined, "journal-fill");
        assert.ok(
            (await journalOf(readerRoot)).some((r) => r.author_root === authorRoot),
            "a change of heart re-earns the page"
        );
    });
});

/*
    The push across nodes: A hosts the author; a member of B follows them. A new post on A must
    reach B's member's journal with NOBODY on B asking after the post exists - A dials B because
    B once asked about this persona (the demand record), and B accepts because someone on B
    wants them (the widened acceptance is what this test breaks without).
*/
(HOST_B ? describe : describe.skip)("fan-out: the push", function () {
    this.timeout(90000);

    it("a post on one node lands in a follower's journal on another, unprompted", async function () {
        const author = await makeUserFetch({ prefix: "pushauthor" });
        const far = (await (await author("api/identity", { method: "POST" })).json()).root_pubkey;
        const { toBase58 } = await import("../../js/speakable.js");
        const viaA = toBase58((await (await author("api/node")).json()).endpoint_id);

        // B's member finds them (fetch -> B carries the persona, A records the demand)...
        const fan = await makeUserFetch({ prefix: "pushfan", host: HOST_B });
        const fanRoot = (await (await fan("api/identity", { method: "POST" })).json()).root_pubkey;
        const first = await fan(`api/id/${far}/profile?via=${viaA}`);
        assert.equal(first.status, 200, await first.text());
        // ...and follows them.
        await follow(fan, fanRoot, far, "max");
        await beat(HOST_B, "fold", fanRoot);
        {
            const { rows } = await sql(
                `SELECT 1 FROM subscriptions WHERE local_root = '${fanRoot}'
                 AND foreign_root = '${far}'`,
                HOST_B
            );
            assert.ok(rows.length, "the follow reached B's memo");
        }

        // NOW the author posts, on A. Nothing on B asks for anything after this line.
        const d = await (
            await author(`api/identity/${far}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Across", body: "the wire", format: "plaintext" }),
            })
        ).json();
        const pub = await author(`api/identity/${far}/docs/${d.doc_id}/publish`, {
            method: "POST",
        });
        const postId = JSON.parse(await pub.text()).post_id;

        // A's push, rung by hand: fold on A (journals + queues), then the demand-record
        // push AWAITED - the direction the test pins. B then folds what arrived.
        await beat(undefined, "fold", far);
        await beat(undefined, "demand-push", far);
        await beat(HOST_B, "fold", far);
        const rows = await journalOf(fanRoot, HOST_B);
        assert.ok(rows.length, "the post crossed nodes because A pushed, not because B polled");
        assert.equal(rows[0].author_root, far);
        assert.equal(rows[0].doc_id, postId);
        assert.equal(rows[0].title, "Across");
    });
});

/*
    The feed READ half (GET /api/identity/{root}/feed): one page of the arrival journal, ready
    to render - byline joined from the cache, seen-state joined from the reader's own private
    chain, `mine` for the reader's own posts, strict chronology, keyset paging.
*/
describe("the feed endpoint", () => {
    let me, myRoot, voice, voiceRoot;

    before(async () => {
        voice = await makeUserFetch({ prefix: "feedvoice" });
        voiceRoot = (await (await voice("api/identity", { method: "POST" })).json()).root_pubkey;
        await voice(`api/identity/${voiceRoot}/profile`, {
            method: "POST",
            body: JSON.stringify({ field: "name", value: "A Voice" }),
        });
        me = await makeUserFetch({ prefix: "feedme" });
        myRoot = (await (await me("api/identity", { method: "POST" })).json()).root_pubkey;
        await follow(me, myRoot, voiceRoot, "high");
        await beat(undefined, "fold", myRoot);
        const d = await (
            await voice(`api/identity/${voiceRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Heard", body: "a voice speaks", format: "plaintext" }),
            })
        ).json();
        await voice(`api/identity/${voiceRoot}/docs/${d.doc_id}/publish`, { method: "POST" });
        await beat(undefined, "fold", voiceRoot);
    });

    it("serves a page with the byline joined and seen honest", async () => {
        const resp = await me(`api/identity/${myRoot}/feed`);
        assert.equal(resp.status, 200);
        const page = await resp.json();
        assert.ok(page.items.length, "the followed voice reached my feed");
        const item = page.items.find((i) => i.author === voiceRoot);
        assert.equal(item.title, "Heard");
        assert.equal(item.author_name, "A Voice", "byline from the cache, no db per face");
        assert.equal(item.mine, false);
        assert.equal(
            item.seen,
            undefined,
            "a feed row carries NO read state (One Cursor, 2026-08-09)"
        );
    });

    it("my own posts appear, marked mine", async () => {
        const d = await (
            await me(`api/identity/${myRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Also me", body: "self, published", format: "plaintext" }),
            })
        ).json();
        await me(`api/identity/${myRoot}/docs/${d.doc_id}/publish`, { method: "POST" });
        await beat(undefined, "fold", myRoot);
        const page = await (await me(`api/identity/${myRoot}/feed`)).json();
        const item = page.items.find((i) => i.author === myRoot);
        assert.ok(item, "my own post landed in my own feed");
        assert.equal(item.mine, true);
    });

    it("pages further back with the keyset cursor - the branch no test had walked", async () => {
        // Fill past one page. The first version of the cursor SQL bound five values into four
        // numbered slots and 500'd on exactly this path, behind a silent client catch.
        for (let i = 0; i < 22; i++) {
            const d = await (
                await voice(`api/identity/${voiceRoot}/docs`, {
                    method: "POST",
                    body: JSON.stringify({ title: `Back ${i}`, body: "w", format: "plaintext" }),
                })
            ).json();
            await voice(`api/identity/${voiceRoot}/docs/${d.doc_id}/publish`, { method: "POST" });
        }
        await beat(undefined, "fold", voiceRoot);
        const first = await (await me(`api/identity/${myRoot}/feed`)).json();
        assert.ok(first.more, "a full first page, with more behind it");
        const last = first.items[first.items.length - 1];
        const resp = await me(
            `api/identity/${myRoot}/feed?before_ms=${last.published_ms}&before_doc=${last.doc_id}`
        );
        const text = await resp.text();
        assert.equal(resp.status, 200, text);
        const second = JSON.parse(text);
        assert.ok(second.items.length > 0, "the past is reachable");
        assert.ok(
            !second.items.some((i) => first.items.some((j) => j.doc_id === i.doc_id)),
            "and never repeats the first page"
        );
    });

    it("refuses a feed that isn't yours", async () => {
        const resp = await voice(`api/identity/${myRoot}/feed`);
        assert.ok([403, 404].includes(resp.status), `got ${resp.status}`);
    });
});

/*
    The two-hop body lane: a post AUTHORED on a secondary device must reach a follower on a
    third node with its BODY - not just its journal row.

    Headers ride entry sync; bodies ride iroh-blobs, joined by an after-exchange fetch. The
    race this pins: the middle node (the device that knows the follower) pushes headers onward
    the moment they land, BEFORE its own body backfill from the authoring device completes -
    so the follower's dial-back for bytes can arrive at a node that doesn't have them yet.
    The property (not the mechanism): the follower ends up with the body anyway, with no
    manual sync and no second post. Today that works because a fruitful body fetch re-rides
    the fan-out edge on both sides of an exchange.
*/
(HOST_B && HOST_C ? describe : describe.skip)("fan-out: the two-hop body", function () {
    this.timeout(120000);

    it("a secondary device's post reaches a remote follower with its body", async () => {
        // Alice: senior device on A, second device on B (the adopt ceremony).
        const a1 = await makeUserFetch({ prefix: "hopsenior" });
        const root = (await (await a1("api/identity", { method: "POST" })).json()).root_pubkey;
        const a2 = await makeUserFetch({ prefix: "hopdevice", host: HOST_B });
        const request = await (await a2("api/identity/adopt/begin", { method: "POST" })).json();
        const grant = await (
            await a1(`api/identity/${root}/nodes`, {
                method: "POST",
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        await a2("api/identity/adopt/complete", {
            method: "POST",
            body: JSON.stringify({ code: grant.code }),
        });

        // Bob, on a third node, discovers Alice THROUGH THE SENIOR DEVICE ONLY - so the
        // demand record (who to push to) lives on A1, and A2 has never heard of Bob's node.
        const { toBase58 } = await import("../../js/speakable.js");
        const viaA1 = toBase58((await (await a1("api/node")).json()).endpoint_id);
        const bob = await makeUserFetch({ prefix: "hopbob", host: HOST_C });
        const bobRoot = (await (await bob("api/identity", { method: "POST" })).json()).root_pubkey;
        assert.equal((await bob(`api/id/${root}/profile?via=${viaA1}`)).status, 200);
        await follow(bob, bobRoot, root, "high");
        await beat(HOST_C, "fold", bobRoot);
        {
            const { rows } = await sql(
                `SELECT 1 FROM subscriptions WHERE local_root = '${bobRoot}'
                 AND foreign_root = '${root}'`,
                HOST_C
            );
            assert.ok(rows.length, "the follow reached C's memo");
        }

        // The post, from the SECOND device. After this line: no manual syncs, no second
        // post, nothing on Bob's node asks for anything. Two hops on their own.
        const d = await (
            await a2(`api/identity/${root}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "Two Hops",
                    body: "written on the second device",
                    format: "plaintext",
                }),
            })
        ).json();
        const pub = await a2(`api/identity/${root}/docs/${d.doc_id}/publish`, { method: "POST" });
        const postId = JSON.parse(await pub.text()).post_id;

        // The two hops rung in the race's WORST order, deterministically: headers pushed
        // B -> A -> C before A ever backfills the body from the authoring device - so C's
        // dial-back for bytes provably meets a node that does not have them yet, and the
        // heal beats afterwards are what close the gap. The property, forced every run.
        await beat(HOST_B, "eager-push", root);
        await beat(undefined, "fold", root);
        await beat(undefined, "demand-push", root);
        await beat(HOST_C, "fold", root);
        const rows = await journalOf(bobRoot, HOST_C);
        assert.ok(rows.length, "the post crossed both hops into the follower's journal");
        assert.equal(rows.length, 1, "exactly one feed row - no duplicates from the re-rides");
        assert.equal(rows[0].doc_id, postId);
        assert.equal(rows[0].title, "Two Hops");

        // And the WORDS arrive - resolved through the same route the feed UI reads, from
        // Bob's own node. This is the assertion the direct-path test never made.
        await beat(undefined, "bodies-sweep"); // A heals from the authoring device...
        await beat(HOST_C, "bodies-sweep"); // ...and C heals from A.
        const resp = await bob(`id/${root}/docs/${postId}/body`);
        assert.equal(resp.status, 200, "the body route answers at the follower's node");
        assert.equal(
            await resp.text(),
            "written on the second device",
            "the body itself crossed both hops"
        );
    });
});
