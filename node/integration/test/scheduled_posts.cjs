/*
    PUBLISH.md slice 2: a future preferred date is a schedule. Nothing touches the public
    chain until the day; the author's node mints it when its moment comes - the same bake
    door, the same after-mint duties - and a second beat mints nothing twice.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

describe("scheduled posts: a future date holds the mint until its day", function () {
    this.timeout(600000);

    let ada, adaRoot, draft, at;

    const shelf = async () => ((await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || []);

    before(async () => {
        ada = await makeUserFetch({ prefix: "schedada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
    });

    it("publishing with a future date schedules instead of minting", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "next year", body: "from the future", format: "plaintext" }),
            })
        ).json();
        draft = made.doc_id;
        await ada(`api/identity/${adaRoot}/docs/${draft}/annotations/fields/display_date`, {
            method: "PUT",
            body: JSON.stringify({ value: "2031-01-01" }),
        });
        const pub = await ada(`api/identity/${adaRoot}/docs/${draft}/publish`, { method: "POST" });
        const body = JSON.parse(await pub.text());
        assert.equal(pub.status, 200);
        assert.ok(!body.post_id, "nothing minted");
        assert.ok(body.scheduled_for > Date.now(), "scheduled for a moment ahead");
        at = body.scheduled_for;
        assert.equal((await shelf()).some((p) => p.title === "next year"), false, "nothing public");
    });

    it("the sweep leaves it alone before its day", async () => {
        const beat = await ada("test/beat", { method: "POST", body: JSON.stringify({ pass: "publish-due", root: adaRoot }) });
        assert.equal(beat.status, 200, await beat.text());
        assert.equal((await shelf()).some((p) => p.title === "next year"), false, "still nothing public");
    });

    it("and mints it once the day comes - exactly once", async () => {
        const ring = () =>
            ada("test/beat", {
                method: "POST",
                body: JSON.stringify({ pass: "publish-due", root: adaRoot, at_ms: at + 1000 }),
            });
        assert.equal((await ring()).status, 200);
        const posts = (await shelf()).filter((p) => p.title === "next year");
        assert.equal(posts.length, 1, "minted");
        assert.equal(posts[0].published_ms, at, "under its scheduled moment");
        assert.equal((await ring()).status, 200);
        assert.equal((await shelf()).filter((p) => p.title === "next year").length, 1, "never twice");
    });
});
