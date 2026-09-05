/*
    PEEK.md slice 1: every exchange has a budget. The rig runs every node with a sixty-entry
    budget per direction (justfile: RINGTOME_SYNC_BUDGET_ENTRIES=60), far under the default
    five thousand, so a persona with a hundred and fifty posts cannot arrive in one exchange:
    one pass carries a budget's worth and leaves the requester provably behind; the wake's
    continuation chains passes until the frontier is caught up; the behind mark is what the
    next beat reads. Every other suite's histories sit under sixty and never notice.

    What this deliberately cannot prove from JavaScript: a peer that never says Done, a
    connection that never sends its first frame, an exchange that trickles past the wall
    clock, a flood of connections past the ceiling. Those bounds live in net::admission
    (unit-tested as a gate) and in sync.rs's deadlines; the rig has no malicious peer to
    drive them, and a fake one is its own arc (PEEK.md residuals).
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");
const { HOST_B } = require("./fetch.cjs");

const BUDGET = 60;
const POSTS = 150;
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

(HOST_B ? describe : describe.skip)("exchange budgets: a long history arrives over passes, never in one", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot;

    /// How many of ada's posts bea's node holds, walking the mirror's shelf page by page.
    const heldByBea = async () => {
        let count = 0;
        let cursor = "";
        for (let page = 0; page < 40; page++) {
            const r = await (await bea(`api/id/${adaRoot}/posts${cursor}`)).json();
            const posts = r.posts || [];
            count += posts.length;
            if (!r.more || !posts.length) break;
            const last = posts[posts.length - 1];
            cursor = `?after_ms=${last.published_ms || 0}&after_doc=${last.doc_id}`;
        }
        return count;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "budgetada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        // A hundred and fifty posts: more than two budgets' worth, and honest.
        for (let i = 0; i < POSTS; i++) {
            const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: `post ${i}`, body: `words ${i}`, format: "plaintext" })).json();
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
            assert.equal(pub.status, 200, await pub.text());
        }
        bea = await makeUserFetch({ prefix: "budgetbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        // No lens-page look and no follow dial yet: the look chains continuations, and a
        // follow lets the wake pass fetch on its own beat - either would converge before
        // the single exchange below could be measured. The first contact is the beat's.
    });

    it("one exchange carries a budget's worth and no more", async function () {
        await beat(HOST_B, "pull-once", adaRoot);
        const held = await heldByBea();
        if (held === 0) this.skip(); // ada's node unreachable from bea's: nothing to measure
        assert.ok(held <= BUDGET, `one exchange carried ${held}, the budget is ${BUDGET}`);
        assert.ok(held < POSTS, "a hundred and fifty posts do not fit one exchange");
    });

    it("the wake's continuation catches up over passes, and the whole history stands", async () => {
        // Now the follow: the demand signal that keeps ada wanted here from now on.
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        let held = 0;
        for (let i = 0; i < 12 && held < POSTS; i++) {
            await beat(HOST_B, "pull", adaRoot);
            held = await heldByBea();
        }
        assert.equal(held, POSTS, "every post arrived, budget by budget");
    });

    it("a caught-up persona is not behind: another pass moves nothing", async () => {
        await beat(HOST_B, "pull-once", adaRoot);
        assert.equal(await heldByBea(), POSTS);
    });
});
