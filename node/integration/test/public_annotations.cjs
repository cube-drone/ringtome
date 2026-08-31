/*
    The annotations arc, slice 1 (ANNOTATIONS.md): the wire and the mint.

    A public annotation is a statement on the SPEAKER's chain - LWW per (target, key,
    value), one statement per tag, retracted by restating it absent. Publishing a draft
    restates every annotation it carries - tags, fields, and its bucket - about the fresh
    post, on the author's own chain (copy, don't flip: the draft keeps its private facts).
    The permalink read serves the author's own statements from the author's shelf, so a
    mirror-holding node answers too - which is the sync scope proven along the way.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { sql, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold, shareArrives } = require("./beat.cjs");
const { HOST } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

describe("public annotations: the wire and the mint", function () {
    this.timeout(600000);

    let ada, adaRoot, post, draft, bea, beaRoot;

    const mine = async (doc) =>
        (await (await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${doc}`)).json())
            .items || [];

    before(async () => {
        ada = await makeUserFetch({ prefix: "annada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
    });

    it("publishing restates the draft's annotations - tags, fields, bucket - about the post", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "labelled", body: "the words", format: "plaintext" }),
            })
        ).json();
        draft = made.doc_id;
        for (const tag of ["mighty", "saucy"]) {
            await ada(`api/identity/${adaRoot}/docs/${draft}/annotations/tags/${tag}`, { method: "PUT" });
        }
        await ada(`api/identity/${adaRoot}/docs/${draft}/annotations/fields/description`, {
            method: "PUT",
            body: JSON.stringify({ value: "a post about sauce" }),
        });
        await ada(`api/identity/${adaRoot}/docs/${draft}/buckets/blog`, { method: "PUT" });
        const pub = await ada(`api/identity/${adaRoot}/docs/${draft}/publish`, { method: "POST" });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        post = JSON.parse(text).post_id;

        const said = await mine(post);
        const has = (k, v) => said.some((s) => s.key === k && s.value === v);
        assert.ok(has("tag", "mighty") && has("tag", "saucy"), "both tags, one statement each");
        assert.ok(has("description", "a post about sauce"), "the description");
        assert.ok(has("bucket", "blog"), "the bucket comes too - it is the label, not a leak");
    });

    it("a statement by hand joins the same chain, and a retraction restates it absent", async () => {
        const put = await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}`, {
            method: "PUT",
            body: JSON.stringify({ key: "tag", value: "goopy" }),
        });
        assert.equal(put.status, 200, await put.text());
        assert.ok((await mine(post)).some((s) => s.key === "tag" && s.value === "goopy"));
        const del = await ada(
            `api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}/tag/goopy`,
            { method: "DELETE" }
        );
        assert.equal(del.status, 200, await del.text());
        assert.ok(
            !(await mine(post)).some((s) => s.key === "tag" && s.value === "goopy"),
            "retracted: the present set no longer names it"
        );
        assert.ok(
            (await mine(post)).some((s) => s.key === "tag" && s.value === "mighty"),
            "and the others stand - LWW per statement, never per post"
        );
    });

    it("a tag is 32 characters at most, and the refusal has words", async () => {
        const put = await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}`, {
            method: "PUT",
            body: JSON.stringify({ key: "tag", value: "x".repeat(33) }),
        });
        assert.equal(put.status, 400);
        assert.match(await put.text(), /32 characters/);
        const ok = await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}`, {
            method: "PUT",
            body: JSON.stringify({ key: "description", value: "y".repeat(600) }),
        });
        assert.equal(ok.status, 200, "a description keeps the wire's cap");
    });

    it("the permalink read carries the author's own statements", async () => {
        const head = await (await ada(`api/id/${adaRoot}/posts/${post}`)).json();
        const has = (k, v) => (head.annotations || []).some((a) => a.key === k && a.value === v);
        assert.ok(has("tag", "mighty") && has("bucket", "blog"), "labels on the post's own read");
    });

    it("the shelf listing carries the labels too - tags show wherever a post shows", async () => {
        // The person page's list reads `api/id/{root}/posts`; its rows wear the same
        // labels the permalink and feed wear (the two surfaces slice 2 missed, closed
        // 2026-08-30).
        const page = await (await ada(`api/id/${adaRoot}/posts`)).json();
        const row = (page.posts || []).find((p) => p.doc_id === post);
        assert.ok(row, "the post is on the shelf");
        assert.ok(
            (row.annotations || []).some((a) => a.key === "tag" && a.value === "mighty"),
            "and wears its labels there"
        );
    });

    it("the chain syncs like any public service - a mirror-holding node answers too", async function () {
        if (!HOST_B) this.skip();
        bea = await makeUserFetch({ prefix: "annbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        const viaAda = await base58(ada);
        if ((await bea(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        await bea(`api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await pullAndFold(HOST_B, adaRoot);
        const head = await (await bea(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.ok(
            (head.annotations || []).some((a) => a.key === "tag" && a.value === "saucy"),
            "the annotations chain crossed the wire with the rest of the persona"
        );
    });

    it("the memo dresses the feed - the author's labels ride every post surface (slice 2)", async function () {
        if (!bea) this.skip();
        // bea follows ada; ada's post is a row in bea's feed, and the memo (folded from
        // ada's mirrored chain on bea's node) dresses it with ada's own labels.
        await beat(HOST_B, "fold", adaRoot);
        const page = await (await bea(`api/identity/${beaRoot}/feed`)).json();
        const row = (page.items || []).find((i) => i.doc_id === post);
        assert.ok(row, "ada's post reached bea's feed");
        const labels = row.annotations || [];
        assert.ok(
            labels.some((a) => a.annotator === adaRoot && a.key === "tag" && a.value === "mighty"),
            "the author's tag, bylined as the author's"
        );
        assert.ok(labels.some((a) => a.key === "bucket" && a.value === "blog"), "and the bucket");
    });

    it("a friend's label arrives by subscription, with provenance - and its retraction takes it back", async function () {
        if (!bea) this.skip();
        // bea tags ada's post on HER chain; ada follows bea, pulls, folds - and the memo
        // on ada's node knows a label by bea. Never merged with ada's own: the annotator
        // rides the row. Then bea takes it back, and the row goes with the fold that saw it.
        const put = await bea(`api/identity/${beaRoot}/public-annotations/${adaRoot}/${post}`, {
            method: "PUT",
            body: JSON.stringify({ key: "tag", value: "goopy" }),
        });
        assert.equal(put.status, 200, await put.text());
        // The tagged notice, envelope road (ANNOTATIONS.md slice 4): ada does not follow
        // bea yet, so the news arrives at her door - a murmur naming her post.
        await beat(HOST_B, "outbox");
        {
            const bell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
            const row = (bell.items || []).find((i) => i.author === beaRoot && i.kind === "tagged");
            assert.ok(row, "the label rang ada's bell");
            assert.equal(row.doc_id, post, "naming her post");
            assert.equal(row.stranger, true, "by envelope - the murmur ring");
        }
        // Read-your-writes on the annotator's OWN node, no beat (Curtis, 2026-08-31: a tag
        // on someone else's post vanished on refresh - the memo waited for a sweep): the
        // PUT's 200 means the label shows on the post's own read here.
        const mineNow = await (await bea(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.ok(
            (mineNow.annotations || []).some((a) => a.value === "goopy" && a.annotator === beaRoot),
            "the label shows on the annotator's node before any beat"
        );
        const viaBea = await base58(bea);
        if ((await ada(`api/id/${beaRoot}/profile?via=${viaBea}`)).status !== 200) this.skip();
        await ada(`api/identity/${adaRoot}/private/kv/contact:${beaRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(HOST, "pull", adaRoot);
        await beat(HOST, "fold", beaRoot);
        let head = await (await ada(`api/id/${adaRoot}/posts/${post}`)).json();
        const goopy = (head.annotations || []).find((a) => a.value === "goopy");
        assert.ok(goopy, "bea's label reached ada's node through bea's chain");
        assert.equal(goopy.annotator, beaRoot, "and it names bea, never ada");
        // The derived road: ada follows bea now, so the fold speaks and the delivered
        // copy yields - one row, not a stranger.
        {
            const bell = await (await ada(`api/identity/${adaRoot}/notifications`)).json();
            const rows = (bell.items || []).filter((i) => i.author === beaRoot && i.kind === "tagged");
            assert.equal(rows.length, 1, "one label notice, the roads dedupe");
            assert.ok(!rows[0].stranger, "derived from a followed chain");
        }

        const del = await bea(
            `api/identity/${beaRoot}/public-annotations/${adaRoot}/${post}/tag/goopy`,
            { method: "DELETE" }
        );
        assert.equal(del.status, 200, await del.text());
        await beat(HOST, "pull", adaRoot);
        await beat(HOST, "fold", beaRoot);
        head = await (await ada(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.ok(
            !(head.annotations || []).some((a) => a.value === "goopy"),
            "a retraction on bea's chain takes the memo row with it"
        );
    });

    it("labels ride the fragment - a node holding nothing else receives them (slice 3)", async function () {
        if (!bea || !HOST_C) this.skip();
        // cal follows bea's SHARES only. bea re-tags and rebroadcasts ada's post, and the
        // labels reach cal's node - by the fragment's proofs, and on THIS topology also by
        // a second road (bea's published vouch for ada gets ada speculatively mirrored
        // here, and the chain fold delivers the same rows), so this claim proves arrival,
        // not the road. The PLANTED road-proof is the two-hop claim below: eve's node has
        // no vouch toward ada and no chain but cal's, so only the fragment can carry hers.
        const put = await bea(`api/identity/${beaRoot}/public-annotations/${adaRoot}/${post}`, {
            method: "PUT",
            body: JSON.stringify({ key: "tag", value: "viral-goop" }),
        });
        assert.equal(put.status, 200, await put.text());
        const cal = await makeUserFetch({ prefix: "anncal", host: HOST_C });
        const calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        const viaBea = await base58(bea);
        if ((await cal(`api/id/${beaRoot}/profile?via=${viaBea}`)).status !== 200) this.skip();
        await cal(`api/identity/${calRoot}/private/kv/contact:${beaRoot}/interest_rebroadcasts`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(HOST_C, "fold", calRoot);
        const shared = await bea(`api/identity/${beaRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: adaRoot, doc_id: post }),
        });
        assert.equal(shared.status, 200, await shared.text());
        let labels = [];
        for (let i = 0; i < 30 && !labels.some((l) => l.value === "mighty"); i++) {
            await shareArrives(HOST_C, beaRoot, adaRoot);
            const { rows } = await sql(
                `SELECT annotator, value FROM doc_annotations WHERE target_doc = '${post}'`,
                HOST_C
            );
            labels = rows;
        }
        assert.ok(
            labels.some((l) => l.annotator === adaRoot && l.value === "mighty"),
            "ada's label arrived by fragment - her chain was never here"
        );
        assert.ok(
            labels.some((l) => l.annotator === beaRoot && l.value === "viral-goop"),
            "and bea's, provenance intact"
        );
        this.test.ctx.suite = { cal, calRoot };
    });

    it("and ride the NEXT fragment too - the relay serves kept proofs (slice 3)", async function () {
        if (!HOST_E || !this.test.ctx.suite) this.skip();
        // eve follows cal's shares; cal re-shares. Eve's node has met NOBODY in this story
        // but cal - the labels she receives were relayed as proofs from cal's kept table,
        // each still verifying against ada and bea.
        const { cal, calRoot } = this.test.ctx.suite;
        const eve = await makeUserFetch({ prefix: "anneve", host: HOST_E });
        const eveRoot = (await (await eve("api/identity", { method: "POST" })).json()).root_pubkey;
        const viaCal = await base58(cal);
        if ((await eve(`api/id/${calRoot}/profile?via=${viaCal}`)).status !== 200) this.skip();
        await eve(`api/identity/${eveRoot}/private/kv/contact:${calRoot}/interest_rebroadcasts`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(HOST_E, "fold", eveRoot);
        const onward = await cal(`api/identity/${calRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: adaRoot, doc_id: post }),
        });
        assert.equal(onward.status, 200, await onward.text());
        let labels = [];
        for (let i = 0; i < 30 && !labels.some((l) => l.value === "viral-goop"); i++) {
            await shareArrives(HOST_E, calRoot, adaRoot);
            const { rows } = await sql(
                `SELECT annotator, value FROM doc_annotations WHERE target_doc = '${post}'`,
                HOST_E
            );
            labels = rows;
        }
        assert.ok(
            labels.some((l) => l.annotator === adaRoot && l.value === "mighty") &&
                labels.some((l) => l.annotator === beaRoot && l.value === "viral-goop"),
            "two hops out, both labels stand, each still signed by its own annotator"
        );
    });
});
