/*
    The publication rung, end to end on one node: dialing a contact mints a signed public-edge
    statement onto the author's follows-public chain (publish::reconcile - publication is the
    resting state, so the dial IS the act and `edges_public: no` is what withholds), the
    notification fold routes it to the local personas that follow the author
    (notifications::refresh_from), and the endpoint serves it dressed with seen-state from the
    reader's own private chain.

    Everything below is the DERIVED path (PROJECT_PLAN, Arrival and Attention: the follow-edge
    rule): the reader follows the author, which is why the author's chains are here to fold.
    The non-follower case pins the boundary - reaching someone who doesn't follow you is the
    inbox path's job, and it must NOT leak through this one.
*/
const assert = require("node:assert");
const { sql } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");


const dial = (fetcher, mine, theirs, key, value) =>
    fetcher(`api/identity/${mine}/private/kv/contact:${theirs}/${key}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
    });

let author, authorRoot, reader, readerRoot, bystander, bystanderRoot;

before(async () => {
    author = await makeUserFetch({ prefix: "pubauthor" });
    authorRoot = (await (await author("api/identity", { method: "POST" })).json()).root_pubkey;
    reader = await makeUserFetch({ prefix: "pubreader" });
    readerRoot = (await (await reader("api/identity", { method: "POST" })).json()).root_pubkey;
    bystander = await makeUserFetch({ prefix: "pubbystander" });
    bystanderRoot = (await (await bystander("api/identity", { method: "POST" })).json())
        .root_pubkey;

    // The reader follows the author - the follow-edge that licenses the derived path. The
    // bystander deliberately does not.
    await dial(reader, readerRoot, authorRoot, "interest", "high");
});

const notificationRows = async (readerHex) => {
    const { rows } = await sql(
        `SELECT author_root, kind, trust, interest, updated_ms FROM notifications
         WHERE reader_root = '${readerHex}'`
    );
    return rows;
};

describe("edge publication and its notification", () => {
    it("dialing a relationship mints the statement and the follower is notified", async () => {
        // No `edges_public` write anywhere here: publication is the resting state, so the
        // dials themselves are the publishing act (settled 2026-08-09).
        await dial(author, authorRoot, readerRoot, "trust", "max");
        await dial(author, authorRoot, readerRoot, "interest", "medium");

        await beat(undefined, "mint", authorRoot);
        await beat(undefined, "fold", authorRoot);
        const rows = await notificationRows(readerRoot);
        assert.ok(
            rows.length && rows[0].trust === "max" && rows[0].interest === "medium",
            "the published edge became a notification row"
        );
        assert.equal(rows.length, 1, "collapse by (sender, kind): one row per author");
        assert.equal(rows[0].author_root, authorRoot);
        assert.equal(rows[0].kind, "public-edge");
        assert.equal(rows[0].trust, "max", "the band as published, as set");
        assert.equal(rows[0].interest, "medium");
    });

    it("a dial turned while consented updates the row in place", async () => {
        await dial(author, authorRoot, readerRoot, "trust", "high");
        await beat(undefined, "mint", authorRoot);
        await beat(undefined, "fold", authorRoot);
        const rows = await notificationRows(readerRoot);
        assert.ok(
            rows.length === 1 && rows[0].trust === "high",
            "the statement was re-published and the row updated, never stacked"
        );
    });

    it("the endpoint dresses the row, and the watermark makes it seen everywhere", async () => {
        const page = await (
            await reader(`api/identity/${readerRoot}/notifications`)
        ).json();
        assert.equal(page.items.length, 1);
        const item = page.items[0];
        assert.equal(item.author, authorRoot);
        assert.equal(item.kind, "public-edge");
        assert.equal(item.seen, false, "nothing marked yet");

        await reader(`api/identity/${readerRoot}/private/kv/notifications_seen/watermark`, {
            method: "PUT",
            body: JSON.stringify({ value: String(item.updated_ms) }),
        });
        const after = await (
            await reader(`api/identity/${readerRoot}/notifications`)
        ).json();
        assert.equal(after.items[0].seen, true, "the watermark is the seen cursor");
        assert.equal(after.watermark, item.updated_ms);
    });

    it("a published edge toward a NON-follower notifies nobody - the derived path's boundary", async () => {
        await dial(author, authorRoot, bystanderRoot, "trust", "max");

        // The statement mints regardless (publication is the author's act; who reads it is
        // not the mint's business) - proven by the follower case above. What must NOT happen
        // is a row for someone who never chose to sync this author.
        // The pass, provably run and provably silent for the bystander - no sleep needed.
        await beat(undefined, "mint", authorRoot);
        await beat(undefined, "fold", authorRoot);
        assert.deepEqual(
            await notificationRows(bystanderRoot),
            [],
            "no follow-edge, no derived notification"
        );
    });

    it("going private retracts the statement and the notification with it", async () => {
        await dial(author, authorRoot, readerRoot, "edges_public", "no");
        await beat(undefined, "mint", authorRoot);
        await beat(undefined, "fold", authorRoot);
        assert.equal(
            (await notificationRows(readerRoot)).length,
            0,
            "a retraction is an absence, not a notification"
        );
    });
});
