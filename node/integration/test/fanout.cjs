/*
    Fan-out: the moment a persona's public lane moves, readers hear about it - locally as a
    journal row, remotely as a push over the ordinary sync exchange.

    The design being pinned: there is NO notification message anywhere. The push is a sync, the
    receiver's own gate validates what arrives, and the receiver's own journal write is the
    "notification". Ordering and ranking are absent on purpose - the journal is "honest about
    what came" (Journal, then index), and how a feed READS is decided when its reader opens it.
*/
const assert = require("node:assert");
const { sql, HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");

const settle = async (fn, tries = 80) => {
    for (let i = 0; i < tries; i++) {
        const got = await fn();
        if (got) return got;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
};

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
        await follow(reader, readerRoot, authorRoot, 75);
        // The follow must be in the subscription memo BEFORE the post, or the edge fires into
        // an empty follower list.
        const subscribed = await settle(async () => {
            const { rows } = await sql(
                `SELECT 1 FROM subscriptions WHERE local_root = '${readerRoot}'
                 AND foreign_root = '${authorRoot}'`
            );
            return rows.length ? true : null;
        });
        assert.ok(subscribed, "the follow reached the memo");

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

        const rows = await settle(async () => {
            const j = await journalOf(readerRoot);
            return j.length ? j : null;
        });
        assert.ok(rows, "the journal row arrived without the reader doing anything");
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

        const updated = await settle(async () => {
            const j = await journalOf(readerRoot);
            return j[0].updated_ms > before[0].updated_ms ? j : null;
        });
        assert.ok(updated, "the row noticed the new words");
        assert.equal(updated.length, before.length, "saying it better is not saying it again");
        assert.equal(updated[0].published_ms, before[0].published_ms, "and it kept its date");
        assert.equal(updated[0].arrived_ms, before[0].arrived_ms, "and its arrival");
    });

    it("'don't show' means it - interest zero journals nothing", async () => {
        const shunner = await makeUserFetch({ prefix: "fanshun" });
        const shunRoot = (await (await shunner("api/identity", { method: "POST" })).json())
            .root_pubkey;
        await follow(shunner, shunRoot, authorRoot, 0);
        await settle(async () => {
            const { rows } = await sql(
                `SELECT 1 FROM subscriptions WHERE local_root = '${shunRoot}'`
            );
            return rows.length ? true : null;
        });
        const d = await (
            await author(`api/identity/${authorRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Second", body: "more", format: "plaintext" }),
            })
        ).json();
        await author(`api/identity/${authorRoot}/docs/${d.doc_id}/publish`, { method: "POST" });
        // The follower at 75 hears about it; the zero does not. Settling on the follower's
        // journal growing proves the pass RAN, so the shunner's silence is a decision, not lag.
        const grew = await settle(async () => {
            const j = await journalOf(readerRoot);
            return j.length >= 2 ? j : null;
        });
        assert.ok(grew, "the real follower's journal grew");
        assert.deepEqual(await journalOf(shunRoot), [], "the zero-interest reader heard nothing");
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
        await follow(fan, fanRoot, far, 100);
        const ready = await settle(async () => {
            const { rows } = await sql(
                `SELECT 1 FROM subscriptions WHERE local_root = '${fanRoot}'
                 AND foreign_root = '${far}'`,
                HOST_B
            );
            return rows.length ? true : null;
        });
        assert.ok(ready, "the follow reached B's memo");

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

        const rows = await settle(async () => {
            const j = await journalOf(fanRoot, HOST_B);
            return j.length ? j : null;
        });
        assert.ok(rows, "the post crossed nodes because A pushed, not because B polled");
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
        await follow(me, myRoot, voiceRoot, 75);
        await settle(async () => {
            const { rows } = await sql(
                `SELECT 1 FROM subscriptions WHERE local_root = '${myRoot}'`
            );
            return rows.length ? true : null;
        });
        const d = await (
            await voice(`api/identity/${voiceRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Heard", body: "a voice speaks", format: "plaintext" }),
            })
        ).json();
        await voice(`api/identity/${voiceRoot}/docs/${d.doc_id}/publish`, { method: "POST" });
    });

    it("serves a page with the byline joined and seen honest", async () => {
        const page = await settle(async () => {
            const resp = await me(`api/identity/${myRoot}/feed`);
            if (resp.status !== 200) return null;
            const body = await resp.json();
            return body.items.length ? body : null;
        });
        assert.ok(page, "the followed voice reached my feed");
        const item = page.items.find((i) => i.author === voiceRoot);
        assert.equal(item.title, "Heard");
        assert.equal(item.author_name, "A Voice", "byline from the cache, no db per face");
        assert.equal(item.seen, false, "not seen until I say so");
        assert.equal(item.mine, false);
    });

    it("marks seen through the ordinary private KV - and it sticks", async () => {
        const first = await (await me(`api/identity/${myRoot}/feed`)).json();
        const item = first.items.find((i) => i.author === voiceRoot);
        const put = await me(`api/identity/${myRoot}/private/kv/feed_seen/${item.doc_id}`, {
            method: "PUT",
            body: JSON.stringify({ value: "1" }),
        });
        assert.equal(put.status, 200, await put.text());
        const again = await (await me(`api/identity/${myRoot}/feed`)).json();
        const seen = again.items.find((i) => i.doc_id === item.doc_id);
        assert.equal(seen.seen, true, "a seen mark is a private-chain fact, and it travels");
    });

    it("my own posts appear, mine and pre-seen - I was there when I wrote them", async () => {
        const d = await (
            await me(`api/identity/${myRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "Also me", body: "self, published", format: "plaintext" }),
            })
        ).json();
        await me(`api/identity/${myRoot}/docs/${d.doc_id}/publish`, { method: "POST" });
        const item = await settle(async () => {
            const page = await (await me(`api/identity/${myRoot}/feed`)).json();
            return page.items.find((i) => i.author === myRoot) || null;
        });
        assert.ok(item, "my own post landed in my own feed");
        assert.equal(item.mine, true);
        assert.equal(item.seen, true);
    });

    it("refuses a feed that isn't yours", async () => {
        const resp = await voice(`api/identity/${myRoot}/feed`);
        assert.ok([403, 404].includes(resp.status), `got ${resp.status}`);
    });
});
