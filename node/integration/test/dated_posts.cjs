/*
    PUBLISH.md slice 1: the preferred date on the wire. A post whose draft claims a date files
    under that date everywhere - the author's shelf and a follower's feed alike - while the
    mint moment stays what it is (the edit window's anchor, the dossier's honest "when").
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { pullAndFold } = require("./beat.cjs");
const { HOST_B } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

const MAY_4_2019 = 1_556_928_000_000;

describe("dated posts: the preferred date sorts the post everywhere", function () {
    this.timeout(600000);

    let ada, adaRoot, fresh, dated;

    const publish = async (title, body, date) => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title, body, format: "plaintext" }),
            })
        ).json();
        if (date) {
            await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/annotations/fields/display_date`, {
                method: "PUT",
                body: JSON.stringify({ value: date }),
            });
        }
        const pub = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, { method: "POST" });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return JSON.parse(text).post_id;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: "dateada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
    });

    it("files under the claimed date on the author's shelf, behind everything newer", async () => {
        fresh = await publish("today", "said now", null);
        dated = await publish("an old day", "written up years later", "2019-05-04");
        const shelf = await (await ada(`api/id/${adaRoot}/posts`)).json();
        const ids = (shelf.posts || []).map((p) => p.doc_id);
        assert.ok(ids.indexOf(fresh) < ids.indexOf(dated), "the dated post sorts into the past");
        const old = shelf.posts.find((p) => p.doc_id === dated);
        // A bare day takes the publication's own time-of-day (UTC here: the harness sends
        // no offset), so the stamp lands inside May 4th at roughly "now o'clock".
        const DAY = 86_400_000;
        assert.ok(old.published_ms >= MAY_4_2019 && old.published_ms < MAY_4_2019 + DAY, "inside the claimed day");
        const nowTod = Date.now() % DAY;
        const stampTod = old.published_ms - MAY_4_2019;
        assert.ok(Math.abs(stampTod - nowTod) < 120_000, "at the publication's own hour");
        assert.equal(old.dated_ms, old.published_ms);
        assert.ok(old.minted_ms > MAY_4_2019 + DAY, "while the mint moment stays honest");
        const head = await (await ada(`api/id/${adaRoot}/posts/${dated}`)).json();
        assert.equal(head.published_ms, old.published_ms, "the permalink agrees");
    });

    it("lands in the past on a follower's feed too", async function () {
        if (!HOST_B) this.skip();
        const bea = await makeUserFetch({ prefix: "datebea", host: HOST_B });
        const beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        const viaAda = await base58(ada);
        if ((await bea(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        await bea(`api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        let row = null;
        for (let i = 0; i < 30 && !row; i++) {
            await pullAndFold(HOST_B, adaRoot);
            const feed = await (await bea(`api/identity/${beaRoot}/feed`)).json();
            row = (feed.items || []).find((it) => it.doc_id === dated);
            if (!row) await new Promise((r) => setTimeout(r, 300));
        }
        assert.ok(row, "the dated post reached the follower");
        assert.ok(row.published_ms >= MAY_4_2019 && row.published_ms < MAY_4_2019 + 86_400_000,
            "journaled inside its claimed day");
    });
});
