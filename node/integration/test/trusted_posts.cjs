/*
    PROJECT_PLAN's Post visibility slice 2: trusted-only posts. Title public, body gated - the words go only
    to readers the author publishes trust for, checked at serve time against the author's
    own FOLLOWS_PUBLIC edges. The HTTP door here; the node-to-node doors are slice 2b.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch, makePng } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { sql, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");
const { shareArrives } = require("./beat.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

describe("trusted-only posts: the body goes to trusted readers", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, post, draft;

    before(async () => {
        ada = await makeUserFetch({ prefix: "trustada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "trustbea" });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
    });

    it("the flag rides the publish; the title stays public", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "for my people", body: "the quiet words", format: "plaintext" }),
            })
        ).json();
        const pub = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
            body: JSON.stringify({ trusted_only: true }),
        });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        post = JSON.parse(text).post_id;
        draft = made.doc_id;
        // The public face, for an untrusted reader: existence, title, date - and the flag.
        const head = await (await bea(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.title, "for my people", "the title is the post's public face");
        assert.equal(head.trusted_only, true);
    });

    it("the body refuses an untrusted reader with honest words, and serves the author", async () => {
        const no = await bea(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(no.status, 403, await no.clone().text());
        assert.match(await no.text(), /people they trust/);
        const own = await ada(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(own.status, 200, await own.clone().text());
        assert.equal(await own.text(), "the quiet words");
    });

    it("publishing trust opens the door - at serve time, no re-publication", async () => {
        await ada(`api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(undefined, "mint", adaRoot);
        const yes = await bea(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(yes.status, 200, await yes.clone().text());
        assert.equal(await yes.text(), "the quiet words");
    });

    it("across nodes, the body is ciphertext and the KEY travels the trusted lane", async function () {
        if (!HOST_B) this.skip();
        // cara, on another node, follows ada - her node mirrors the chains and pulls the
        // ciphertext like any bytes. The words appear only after ada trusts her and her
        // node earns the key over the lane.
        const cara = await makeUserFetch({ prefix: "trustcara", host: HOST_B });
        const caraRoot = (await (await cara("api/identity", { method: "POST" })).json()).root_pubkey;
        await cara(`api/identity/${caraRoot}/serve`, { method: "POST" });
        const viaAda = await base58(ada);
        if ((await cara(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        await cara(`api/identity/${caraRoot}/private/kv/contact:${adaRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await pullAndFold(HOST_B, adaRoot);
        // Untrusted: her node can see the flag (it mirrors ada), so the gate refuses.
        const no = await cara(`id/${adaRoot}/docs/${post}/body`);
        assert.notEqual(no.status, 200, "no words for the untrusted, on any node");
        // ada trusts cara and, so her node can resolve cara's serving record for the
        // key-release check, meets her chains.
        await ada(`api/identity/${adaRoot}/private/kv/contact:${caraRoot}/trust`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(undefined, "mint", adaRoot);
        const viaCara = await base58(cara);
        await ada(`api/id/${caraRoot}/profile?via=${viaCara}`);
        await pullAndFold(undefined, caraRoot);
        await pullAndFold(HOST_B, adaRoot);
        let got = null;
        for (let i = 0; i < 40 && got !== "the quiet words"; i++) {
            const r = await cara(`id/${adaRoot}/docs/${post}/body`);
            if (r.status === 200) got = await r.text();
            else await new Promise((res) => setTimeout(res, 400));
        }
        assert.equal(got, "the quiet words", "the key lane opened the sealed body");
    });

    it("a sealed post's pictures seal too: twin body and thumb open only for the trusted", async () => {
        // A real image into ada's private shelf, then a marquee post embedding it.
        const png = makePng(64, 48);
        const queued = await (
            await ada(`api/identity/${adaRoot}/docs/binary?title=pic`, {
                method: "POST",
                body: png,
                file: true,
            })
        ).json();
        const media = queued.doc_id;
        for (let i = 0; i < 60; i++) {
            const r = await ada(`api/identity/${adaRoot}/docs/${media}/body`);
            if (r.status === 200) break;
            await new Promise((res) => setTimeout(res, 400));
        }
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({
                    title: "sealed picture",
                    body: `![p](/api/identity/${adaRoot}/docs/${media}/body/p.avif)`,
                    format: "marquee",
                }),
            })
        ).json();
        let pub = null;
        for (let i = 0; i < 30; i++) {
            const r = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, {
                method: "POST",
                body: JSON.stringify({ trusted_only: true }),
            });
            const t = JSON.parse(await r.text());
            if (r.status === 200 && t.post_id) {
                pub = t.post_id;
                break;
            }
            await new Promise((res) => setTimeout(res, 400));
        }
        assert.ok(pub, "the sealed picture post published");
        const head = await (await ada(`api/id/${adaRoot}/posts/${pub}`)).json();
        const twin = (head.refs || [])[0];
        assert.ok(twin, "the header names its twin");
        // bea is trusted: picture and thumbnail open.
        const beaBody = await bea(`id/${adaRoot}/docs/${twin}/body`);
        assert.equal(beaBody.status, 200, await beaBody.clone().text());
        assert.equal(beaBody.headers.get("content-type"), "image/avif");
        // dana is not: body AND thumb refuse - a small copy of a sealed image is sealed.
        const dana = await makeUserFetch({ prefix: "trustdana" });
        assert.equal((await dana(`id/${adaRoot}/docs/${twin}/body`)).status, 403);
        assert.equal((await dana(`id/${adaRoot}/docs/${twin}/thumb`)).status, 403);

        // An EDIT re-publishes the picture too (Curtis, 2026-09-03: after editing a sealed
        // post the image 404'd): the re-bake mints a fresh sealed twin, the new body names
        // it, and it opens for the author and the trusted exactly as the first one did.
        const got = await (await ada(`api/identity/${adaRoot}/docs/${made.doc_id}`)).json();
        const save = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "sealed picture",
                body: `edited\n\n![p](/api/identity/${adaRoot}/docs/${media}/body/p.avif)`,
                parents: got.heads.map((h) => h.version),
                format: "marquee",
            }),
        });
        assert.equal(save.status, 200, await save.text());
        let again = null;
        for (let i = 0; i < 30; i++) {
            const r = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, { method: "POST" });
            const t = JSON.parse(await r.text());
            if (r.status === 200 && t.post_id) {
                again = t.post_id;
                break;
            }
            await new Promise((res) => setTimeout(res, 400));
        }
        assert.equal(again, pub, "the same post, re-said");
        const head2 = await (await ada(`api/id/${adaRoot}/posts/${pub}`)).json();
        const twin2 = (head2.refs || [])[0];
        assert.ok(twin2, "the re-said header names a twin");
        const words = await (await ada(`id/${adaRoot}/docs/${pub}/body`)).text();
        assert.match(words, /^edited/, "the new words landed");
        assert.ok(words.includes(`/docs/${twin2}/body/`), "and they name the twin the header names");
        const adaTwin = await ada(`id/${adaRoot}/docs/${twin2}/body`);
        assert.equal(adaTwin.status, 200, `the author's own picture after the edit: ${await adaTwin.clone().text()}`);
        const beaTwin = await bea(`id/${adaRoot}/docs/${twin2}/body`);
        assert.equal(beaTwin.status, 200, `the trusted reader's picture after the edit: ${await beaTwin.clone().text()}`);
        assert.equal(beaTwin.headers.get("content-type"), "image/avif");
        assert.equal((await dana(`id/${adaRoot}/docs/${twin2}/body`)).status, 403, "still sealed to the untrusted");
    });

    // The multi-hop claim (Curtis, 2026-09-02): a rebroadcast spreads the POINTER between
    // nodes - journaled with its flag intact - but a feed never SHOWS a sealed post its
    // reader cannot open (also Curtis, same day: "I'd prefer it if the feed didn't show
    // feed items I can't see"). The journal knows; the feed stays quiet; trust reveals.
    let cal, calRoot, eve, eveRoot;

    const feedRow = async (who, whoRoot) =>
        ((await (await who(`api/identity/${whoRoot}/feed`)).json()).items || []).find(
            (i) => i.doc_id === post
        );
    const journalRow = async (host, readerRoot) =>
        (
            await sql(
                `SELECT trusted_only FROM feed_journal WHERE reader_root = '${readerRoot}' AND doc_id = '${post}'`,
                host
            )
        ).rows[0];

    it("a sealed post is not passed along (Curtis, 2026-09-08): the trusted reader's share is refused, and nothing journals downstream", async function () {
        if (!HOST_C) this.skip();
        cal = await makeUserFetch({ prefix: "trustcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        const viaBea = await base58(bea);
        if ((await cal(`api/id/${beaRoot}/profile?via=${viaBea}`)).status !== 200) this.skip();
        await cal(`api/identity/${calRoot}/private/kv/contact:${beaRoot}/interest_rebroadcasts`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        const shared = await bea(`api/identity/${beaRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: adaRoot, doc_id: post }),
        });
        assert.equal(shared.status, 400, await shared.clone().text());
        assert.match(await shared.text(), /not passed along/, "the refusal has words");
        await shareArrives(HOST_C, beaRoot, adaRoot);
        assert.equal(await journalRow(HOST_C, calRoot), undefined, "no pointer ever reaches cal's journal");
        assert.equal(await feedRow(cal, calRoot), undefined, "and his feed shows nothing");
        const shelf = await (await bea(`api/id/${beaRoot}/posts`)).json();
        assert.ok(!(shelf.posts || []).some((i) => i.kind === "share" && i.doc_id === post), "nothing sits on bea's shelf either");
    });

    it("an edit re-publishes sealed, with no flag on the request (2026-09-03)", async () => {
        // LAST on purpose: every claim above reads the original words. The edit flow says
        // nothing about trust; the wish is carried from the first mint,
        // and so must the key be - this used to 500 ("a trusted-only mint arrived without
        // its key").
        const got = await (await ada(`api/identity/${adaRoot}/docs/${draft}`)).json();
        const save = await ada(`api/identity/${adaRoot}/docs/${draft}`, {
            method: "PUT",
            body: JSON.stringify({
                title: "for my people",
                body: "the quieter words",
                parents: got.heads.map((h) => h.version),
                format: "plaintext",
            }),
        });
        assert.equal(save.status, 200, await save.text());
        const again = await ada(`api/identity/${adaRoot}/docs/${draft}/publish`, { method: "POST" });
        const text = await again.text();
        assert.equal(again.status, 200, text);
        assert.equal(JSON.parse(text).post_id, post, "the same public post, re-said");
        const head = await (await bea(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.trusted_only, true, "still trusted-only");
        // Bea is TRUSTED by now (the claims above published trust for her): the same key
        // opens the new words for her, and a stranger who never met ada still gets the door.
        const stranger = await makeUserFetch({ prefix: "truststranger" });
        const no = await stranger(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(no.status, 403, "still sealed to a stranger");
        assert.equal(await (await bea(`id/${adaRoot}/docs/${post}/body`)).text(), "the quieter words", "the trusted reader gets the new words");
        const own = await ada(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(await own.text(), "the quieter words", "and the author reads the new words");
    });
});
