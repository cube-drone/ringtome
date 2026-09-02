/*
    VISIBILITY.md slice 2: trusted-only posts. Title public, body gated - the words go only
    to readers the author publishes trust for, checked at serve time against the author's
    own FOLLOWS_PUBLIC edges. The HTTP door here; the node-to-node doors are slice 2b.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { sql, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");
const { shareArrives } = require("./beat.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

describe("trusted-only posts: the body goes to trusted readers", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, post;

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

    it("hop 1: the pointer journals with its flag; the feed hides what cal cannot open", async function () {
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
        assert.equal(shared.status, 200, await shared.text());
        let jrow = null;
        for (let i = 0; i < 30 && !jrow; i++) {
            await shareArrives(HOST_C, beaRoot, adaRoot);
            jrow = await journalRow(HOST_C, calRoot);
        }
        assert.ok(jrow, "the pointer reached cal's journal");
        // And bea's own SHELF now lists the share (Curtis, 2026-09-02: the page defaults
        // to everything) - kind-tagged, wearing her as the via.
        {
            const shelf = await (await bea(`api/id/${beaRoot}/posts`)).json();
            const share = (shelf.posts || []).find(
                (i) => i.kind === "share" && i.doc_id === post
            );
            assert.ok(share, "the share sits on the shelf");
            assert.equal(share.via, beaRoot);
            assert.equal(share.author, adaRoot, "the card still belongs to its author");
        }
        assert.equal(jrow.trusted_only, 1, "wearing the flag");
        assert.equal(await feedRow(cal, calRoot), undefined,
            "and the feed shows cal nothing he cannot open");
        const body = await cal(`id/${adaRoot}/docs/${post}/body`);
        assert.notEqual(body.status, 200, "the words sealed against cal");
    });

    it("hop 2: the relay relays; trust reveals the row and opens the body, never for the relay", async function () {
        if (!HOST_E || !calRoot) this.skip();
        eve = await makeUserFetch({ prefix: "trusteve", host: HOST_E });
        eveRoot = (await (await eve("api/identity", { method: "POST" })).json()).root_pubkey;
        await eve(`api/identity/${eveRoot}/serve`, { method: "POST" });
        const viaCal = await base58(cal);
        if ((await eve(`api/id/${calRoot}/profile?via=${viaCal}`)).status !== 200) this.skip();
        await eve(`api/identity/${eveRoot}/private/kv/contact:${calRoot}/interest_rebroadcasts`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        // cal shares onward: the mint needs a held VERSION, and cal's fragment shelf holds
        // the (ciphertext) fragment - carriage never required reading.
        const onward = await cal(`api/identity/${calRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: adaRoot, doc_id: post }),
        });
        assert.equal(onward.status, 200, await onward.text());
        let jrow = null;
        for (let i = 0; i < 30 && !jrow; i++) {
            await shareArrives(HOST_E, calRoot, adaRoot);
            jrow = await journalRow(HOST_E, eveRoot);
        }
        assert.ok(jrow, "the pointer crossed a second hop");
        assert.equal(jrow.trusted_only, 1, "flag intact through the relay");
        assert.equal(await feedRow(eve, eveRoot), undefined, "hidden from eve while untrusted");
        assert.notEqual((await eve(`id/${adaRoot}/docs/${post}/body`)).status, 200,
            "and sealed against her");
        // ada trusts eve, and meets her - the ceremony the real app cannot skip, since
        // trust is dialed from a profile page; it is what puts eve's chains where the
        // key-release check can resolve her serving records.
        await ada(`api/identity/${adaRoot}/private/kv/contact:${eveRoot}/trust`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(undefined, "mint", adaRoot);
        const viaEve = await base58(eve);
        await ada(`api/id/${eveRoot}/profile?via=${viaEve}`);
        await pullAndFold(undefined, eveRoot);
        const viaAda = await base58(ada);
        await eve(`api/id/${adaRoot}/profile?via=${viaAda}`);
        await pullAndFold(HOST_E, adaRoot);
        // Trust REVEALS: the same journal row now surfaces in eve's feed, flag and all.
        let row = null;
        for (let i = 0; i < 40 && !row; i++) {
            row = await feedRow(eve, eveRoot);
            if (!row) await new Promise((res) => setTimeout(res, 400));
        }
        assert.ok(row, "the row appears the moment trust does");
        assert.equal(row.trusted_only, true);
        assert.equal(row.title, "for my people");
        let got = null;
        for (let i = 0; i < 40 && got !== "the quiet words"; i++) {
            const r = await eve(`id/${adaRoot}/docs/${post}/body`);
            if (r.status === 200) got = await r.text();
            else await new Promise((res) => setTimeout(res, 400));
        }
        assert.equal(got, "the quiet words", "trust opens the sealed body two hops out");
        assert.equal(await feedRow(cal, calRoot), undefined, "cal's feed still shows nothing");
        assert.notEqual((await cal(`id/${adaRoot}/docs/${post}/body`)).status, 200,
            "the relay in the middle still cannot read what it carried");
    });
});
