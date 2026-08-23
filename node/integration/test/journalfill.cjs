/*
    The journal's two walks (2026-08-16): coverage after the follow point is contiguous -
    holes forbidden - and history before it arrives at the dig's pace, down to the horizon.

    Two properties, one file:

      * THE LATE FOLLOW: an author with more history than one page (30 posts against the
        20-post window) is followed after the fact. The newest page arrives at follow time
        (the burst-to-bound), and the history dig extends the feed backward a page per beat
        until the whole 30 stand. Before the dig existed, the feed stopped at 20 forever.

      * THE DARK WINDOW: the reader's node sleeps through 25 more posts - wider than one
        page - then wakes. The next arrival journals the EXACT gap: the persisted mark
        (journal_marks) tells the walk how deep to page, where the old in-memory mark
        reset on boot and quietly capped every catch-up at the newest page, skipping the
        rest forever despite the chain being fully held.

    Both are pure chain-lane properties: no shares, no fragments - the dig's posts-only
    first slice. The share lane's history is NEXT_STEPS.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST_C } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { unplug, plugIn } = require("./unplug.cjs");

const settle = require("./helpers.cjs").settleWith(240);

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

(HOST_C ? describe : describe.skip)("the history dig and the exact gap", function () {
    this.timeout(1200000);

    let author, authorRoot, cora, coraRoot;

    const publish = async (title) => {
        const made = await (
            await author(`api/identity/${authorRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title, body: `${title}: the words`, format: "plaintext" }),
            })
        ).json();
        const pub = await author(`api/identity/${authorRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
        });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return JSON.parse(text).post_id;
    };

    const feedRows = async () => {
        const { rows } = await sql(
            `SELECT doc_id, title FROM feed_journal
             WHERE reader_root = '${coraRoot}' AND author_root = '${authorRoot}'`,
            HOST_C
        );
        return rows;
    };

    before(async function () {
        author = await makeUserFetch({ prefix: "digauthor" });
        authorRoot = (await (await author("api/identity", { method: "POST" })).json()).root_pubkey;
        await author(`api/identity/${authorRoot}/serve`, { method: "POST" });

        cora = await makeUserFetch({ prefix: "digcora", host: HOST_C });
        coraRoot = (await (await cora("api/identity", { method: "POST" })).json()).root_pubkey;
        await cora(`api/identity/${coraRoot}/serve`, { method: "POST" });
    });

    afterEach(async () => {
        await plugIn(HOST_C);
    });

    it("a late follow's feed digs past the window, and a dark gap journals exactly", async function () {
        // 30 posts of history - one and a half pages - BEFORE anyone follows.
        for (let i = 1; i <= 30; i++) await publish(`dig-${i}`);

        // The follow, after the fact. The profile fetch mirrors the full chain (sync has no
        // window); the follow backfills the newest page; the dig owes the rest.
        const viaAuthor = await base58(author);
        if ((await cora(`api/id/${authorRoot}/profile?via=${viaAuthor}`)).status !== 200)
            this.skip();
        await cora(`api/identity/${coraRoot}/private/kv/contact:${authorRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });

        // THE LATE FOLLOW: all 30 in the feed - the dig reached below the window.
        assert.ok(
            await settle(async () => ((await feedRows()).length >= 30 ? true : null)),
            "the history dig extended the feed to the whole held shelf"
        );
        const titles = (await feedRows()).map((r) => r.title);
        assert.ok(titles.includes("dig-1"), "the dig reached the very first post");

        // THE DARK WINDOW: the reader's node sleeps through more than a page of posts...
        await unplug(HOST_C);
        for (let i = 1; i <= 25; i++) await publish(`dark-${i}`);
        await plugIn(HOST_C);

        // ...and the next arrival closes the exact gap. The trigger post's push carries every
        // missed entry in one exchange; the persisted mark makes the walk page down to all of
        // them, where the boot-reset mark used to cap this at the newest twenty.
        await publish("the-trigger");
        assert.ok(
            await settle(async () => ((await feedRows()).length >= 56 ? true : null)),
            "every post from the dark stretch journaled - the gap is exact, not one page"
        );
        const after = (await feedRows()).map((r) => r.title);
        for (const mustHold of ["dark-1", "dark-13", "dark-25", "the-trigger"]) {
            assert.ok(after.includes(mustHold), `${mustHold} is in the feed - no holes`);
        }
    });
});
