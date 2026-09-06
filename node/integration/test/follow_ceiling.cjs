/*
    PROJECT_PLAN's Peeks, slice 5: the follow ceiling. The rig runs every node with a two-hundred-entry
    posts ceiling (justfile: RINGTOME_FOLLOW_POSTS_CEILING=200), so a follow of a stranger
    with three hundred posts holds their newest two hundred as a SUFFIX - the oldest held
    entry's prev_hash committing to the prefix - and no more, until scrollback asks: paging
    past what is held backfills beneath the floor, in bounded exchanges, and the floor
    lowers. A pinned post beneath the floor heads the page anyway, fetched by id.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { sql, HOST_B } = require("./fetch.cjs");

const POSTS = 300;
const CEILING = 200;
const DEEP = 5;
const SERVICE_POSTS = 3;
const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

(HOST_B ? describe : describe.skip)("the follow ceiling: a follow holds a suffix, and scrollback backfills beneath it", function () {
    this.timeout(900000);

    let ada, adaRoot, bea, beaRoot, ids = [];

    const range = async () =>
        (await sql(`SELECT floor_seq, head_seq FROM chain_heads WHERE root_pubkey = '${adaRoot}' AND service = ${SERVICE_POSTS}`, HOST_B)).rows[0] || null;

    /// Walk the shelf as bea holds it, page by page, until it says no more; the count held.
    const walk = async () => {
        let count = 0;
        let cursor = "";
        for (let page = 0; page < 40; page++) {
            const r = await (await bea(`api/id/${adaRoot}/posts${cursor}${cursor ? "&" : "?"}as=${beaRoot}`)).json();
            const posts = r.posts || [];
            count += posts.length;
            if (!r.more || !posts.length) break;
            const last = posts[posts.length - 1];
            cursor = `?after_ms=${last.published_ms || 0}&after_doc=${last.doc_id}`;
        }
        return count;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "ceilada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        for (let i = 0; i < POSTS; i++) {
            const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: `post ${i}`, body: `words ${i}`, format: "plaintext" })).json();
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
            const text = await pub.text();
            assert.equal(pub.status, 200, text);
            ids.push(JSON.parse(text).post_id);
        }
        const pinned = await j(ada, `api/identity/${adaRoot}/public-annotations/${adaRoot}/${ids[DEEP]}`, { key: "pin", value: "yes" }, "PUT");
        assert.equal(pinned.status, 200, await pinned.text());
        bea = await makeUserFetch({ prefix: "ceilbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        let r = null;
        for (let i = 0; i < 12 && !(r && Number(r.head_seq) >= POSTS - 1); i++) {
            await pullAndFold(HOST_B, adaRoot);
            r = await range();
        }
    });

    it("the follow holds the newest two hundred as a suffix from a floor above zero", async () => {
        const r = await range();
        assert.ok(r, "the posts chain is held");
        assert.ok(Number(r.head_seq) >= POSTS - 1, `the head arrived: ${JSON.stringify(r)}`);
        assert.ok(Number(r.floor_seq) > 0, `and the floor sits above zero: ${JSON.stringify(r)}`);
        assert.ok(Number(r.head_seq) - Number(r.floor_seq) + 1 <= CEILING + 5, `about a ceiling's worth: ${JSON.stringify(r)}`);
    });

    it("a pin beneath the floor still heads the page, fetched by id", async () => {
        let strip = [];
        for (let i = 0; i < 10 && !strip.includes(ids[DEEP]); i++) {
            strip = ((await (await bea(`api/id/${adaRoot}/profile?as=${beaRoot}`)).json()).pinned || []).map((p) => p.doc_id);
            if (!strip.includes(ids[DEEP])) await new Promise((res) => setTimeout(res, 400));
        }
        assert.deepEqual(strip, [ids[DEEP]], "the pinned post heads the page");
        let body = null;
        for (let i = 0; i < 40 && body === null; i++) {
            const rr = await bea(`id/${adaRoot}/docs/${ids[DEEP]}/body`);
            if (rr.status === 200) body = await rr.text();
            else await new Promise((res) => setTimeout(res, 400));
        }
        assert.equal(body, `words ${DEEP}`, "and its words open");
    });

    it("scrollback backfills beneath the floor: paging back brings the whole history and lowers the floor", async () => {
        let held = 0;
        for (let i = 0; i < 6 && held < POSTS; i++) {
            held = await walk();
        }
        assert.equal(held, POSTS, `every post reachable by paging back: ${held}`);
        const r = await range();
        assert.equal(Number(r.floor_seq), 0, `the floor reached the genesis: ${JSON.stringify(r)}`);
    });
});
