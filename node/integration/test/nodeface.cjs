/*
    The node's public face, the doors (UNAUTHED.md, slice 1, 2026-09-15): with no session at
    all, a stranger asks this node who it hosts and what they have said - the node feed,
    newest first, narrowed by tag, kind and words; its labels; and the listed personas. A
    sealed post never appears; an unlisted persona's posts and name never appear; and the
    switch is the persona's own to flip.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");
const { HOST, makeFetch } = require("./fetch.cjs");

const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

describe("the node's public face: a stranger's doors", function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, open1, open2, tagged, sealed;

    const publish = async (who, root, title, body, tags = [], extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        for (const t of tags) await who(`api/identity/${root}/docs/${d.doc_id}/annotations/tags/${t}`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        assert.equal(pub.status, 200, await pub.clone().text());
        return (await pub.json()).post_id;
    };
    // The stranger: a fetcher with no cookie and no persona.
    const stranger = makeFetch();
    const feedUntil = async (want, tries = 30) => {
        let items = [];
        for (let i = 0; i < tries; i++) {
            items = (await (await stranger("api/node/feed")).json()).items || [];
            if (want(items)) return items;
            await beat(HOST, "fold", adaRoot);
            await beat(HOST, "fold", beaRoot);
            await beat(HOST, "fold", calRoot);
            await wait(300);
        }
        return items;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: "faceada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await j(ada, `api/identity/${adaRoot}/profile`, { field: "name", value: "Ada Face" });
        bea = await makeUserFetch({ prefix: "facebea" });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await j(bea, `api/identity/${beaRoot}/profile`, { field: "name", value: "Bea Face" });
        cal = await makeUserFetch({ prefix: "facecal" });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await j(cal, `api/identity/${calRoot}/profile`, { field: "name", value: "Cal Face" });
        open1 = await publish(ada, adaRoot, "bread again", "the loaf rose overnight", ["bread"]);
        tagged = await publish(bea, beaRoot, "a ride", "forty miles before breakfast", ["bikes", "bread"]);
        sealed = await publish(ada, adaRoot, "for my people", "quiet words", [], { trusted_only: true });
        open2 = await publish(cal, calRoot, "cal's morning", "nothing to report", ["quiet"]);
        assert.equal((await j(cal, `api/identity/${calRoot}/listed`, { listed: false }, "PUT")).status, 200, "cal turns the front page off");
    });

    it("the feed shows every listed persona's open posts, newest first, and never a sealed one or an unlisted persona's", async () => {
        const items = await feedUntil((it) => it.some((p) => p.doc_id === tagged) && it.some((p) => p.doc_id === open1));
        const ids = items.map((p) => p.doc_id);
        assert.ok(ids.includes(open1) && ids.includes(tagged), `both open posts: ${ids.length}`);
        assert.ok(!ids.includes(sealed), "the sealed post is not on the front page");
        assert.ok(!ids.includes(open2), "the unlisted persona's post is not either");
        const at = items.map((p) => p.published_ms);
        assert.deepEqual(at, [...at].sort((a, b) => b - a), "newest first");
        const first = items.find((p) => p.doc_id === tagged);
        assert.equal(first.author_name, "Bea Face", "with the byline the node holds");
        assert.equal(first.mine, false);
        assert.deepEqual((first.annotations || []).filter((a) => a.key === "tag").map((a) => a.value).sort(), ["bikes", "bread"], "and its labels");
    });

    it("the labels count what the stranger may see, and the feed narrows by tag, kind and words", async () => {
        // The front page is the whole node's: other suites' personas share it, so the
        // claims are about OUR posts being there (and not there), never about totals.
        const labels = await (await stranger("api/node/feed/labels")).json();
        const tagsOf = Object.fromEntries((labels.tags || []).map((t) => [t.value, t.count]));
        assert.ok(tagsOf.bread >= 2, "bread counts our two posts at least");
        assert.ok(tagsOf.bikes >= 1);
        assert.ok((labels.kinds || []).some((k) => k.value === "post"), "the kind row");
        const byTag = (await (await stranger("api/node/feed?tag=bikes")).json()).items.map((p) => p.doc_id);
        assert.ok(byTag.includes(tagged), "the tag finds the post");
        const byQuiet = (await (await stranger("api/node/feed?tag=quiet")).json()).items.map((p) => p.doc_id);
        assert.ok(!byQuiet.includes(open2), "the unlisted persona's tagged post is not found");
        const byKind = (await (await stranger("api/node/feed?kind=post")).json()).items.map((p) => p.doc_id);
        assert.ok(byKind.includes(open1) && byKind.includes(tagged) && !byKind.includes(open2), "the kind row keeps ours and drops the unlisted");
        let found = [];
        for (let i = 0; i < 30 && !found.includes(open1); i++) {
            await beat(HOST, "search-index");
            found = (await (await stranger("api/node/feed?q=overnight")).json()).items.map((p) => p.doc_id);
            if (!found.includes(open1)) await wait(300);
        }
        assert.ok(found.includes(open1), "words find the post");
        const sealedWords = (await (await stranger("api/node/feed?q=quiet%20words")).json()).items.map((p) => p.doc_id);
        assert.ok(!sealedWords.includes(sealed), "and never the sealed one");
    });

    it("the people door lists the listed, with the byline, and the switch is the persona's own", async () => {
        const people = (await (await stranger("api/node/personas")).json()).people || [];
        const roots = people.map((p) => p.root);
        assert.ok(roots.includes(adaRoot) && roots.includes(beaRoot), "ada and bea are listed");
        assert.ok(!roots.includes(calRoot), "cal is not");
        assert.equal(people.find((p) => p.root === adaRoot).name, "Ada Face");
        assert.ok(people.find((p) => p.root === adaRoot).speakable, "with their speakable address");
        assert.notEqual((await j(bea, `api/identity/${calRoot}/listed`, { listed: true }, "PUT")).status, 200, "nobody else can flip it");
        assert.equal((await j(cal, `api/identity/${calRoot}/listed`, { listed: true }, "PUT")).status, 200, "cal turns it back on");
        assert.equal((await (await cal(`api/identity/${calRoot}/listed`)).json()).listed, true);
        const again = (await (await stranger("api/node/personas")).json()).people.map((p) => p.root);
        assert.ok(again.includes(calRoot), "and is listed at once");
        const items = (await (await stranger("api/node/feed")).json()).items.map((p) => p.doc_id);
        assert.ok(items.includes(open2), "and so is cal's post");
    });

    it("the pages are the app: the front page, the people page and a persona's page serve the app with a meta head (slice 2)", async () => {
        const { speakable } = await import("../../js/speakable.js");
        for (const path of ["", "people", "home"]) {
            const r = await stranger(path);
            assert.equal(r.status, 200, path);
            const body = await r.text();
            assert.ok(body.includes("/static/") && body.includes("app.js"), `${path || "/"} serves the app`);
        }
        const r = await stranger(`id/${speakable(adaRoot)}`);
        assert.equal(r.status, 200);
        const body = await r.text();
        assert.ok(body.includes("<title>Ada Face</title>"), "the head carries the name");
        assert.ok(body.includes('property="og:title" content="Ada Face"'), "and the OpenGraph title");
        assert.ok(body.includes("app.js"), "and the app takes the body");
    });

    it("a stranger's shelf door still answers, and a session is not needed anywhere here", async () => {
        const r = await stranger("api/node/feed");
        assert.equal(r.status, 200);
        assert.equal((await stranger("api/node/personas")).status, 200);
        assert.equal((await stranger("api/node/feed/labels")).status, 200);
        assert.equal((await stranger(`api/identity/${adaRoot}/listed`)).status, 401, "the switch itself needs the persona");
    });
});
