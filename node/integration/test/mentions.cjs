/*
    Mentions (2026-09-06): a user card in the words - `:::user id=/id/<address>:::` - is
    restated at publish as a `mention=<root>` statement on the author's own labels chain,
    and the persona it names hears of it on the bell by the two roads a tag travels: an
    envelope to their door when they do not pull the author, the derived fold when they do.
    The row's card is the AUTHOR's post. A card naming the author says nothing; an edit
    that drops the card takes the statement back, and the row with it.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");
const { HOST, HOST_B } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("mentions: a user card in the words rings the bell it names", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, draft, post, card;

    const mentionsOn = async (who, author, doc) =>
        ((await (await who(`api/id/${author}/posts/${doc}`)).json()).annotations || []).filter((a) => a.key === "mention");
    const rowsFor = async () =>
        ((await (await bea(`api/identity/${beaRoot}/notifications`)).json()).items || []).filter(
            (i) => i.kind === "mentioned" && i.author === adaRoot
        );

    before(async () => {
        const { speakable } = await import("../../js/speakable.js");
        ada = await makeUserFetch({ prefix: "mentada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        await j(ada, `api/identity/${adaRoot}/profile`, { field: "name", value: "Ada Mentions" });
        bea = await makeUserFetch({ prefix: "mentbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        card = `:::user id=/id/${speakable(beaRoot)}:::`;
        // The friend twice, block and inline; the author once, inline - one statement results.
        const body = `a word for [user id=/id/${speakable(beaRoot)}]a friend[/user]\n\n${card}\n\nand one for [user id=/id/${speakable(adaRoot)}]myself[/user]\n`;
        draft = (await (await j(ada, `api/identity/${adaRoot}/docs`, { title: "with a card", body, format: "marquee" })).json()).doc_id;
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${draft}/publish`, {});
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        post = JSON.parse(said).post_id;
    });

    it("publishing restates the card as a mention statement about the post - and never one naming the author", async () => {
        const said = await mentionsOn(ada, adaRoot, post);
        assert.deepEqual(said.map((a) => a.value), [beaRoot], "one mention, the friend - block and span collapse to one");
        assert.equal(said[0].annotator, adaRoot, "said by the author");
    });

    it("the envelope road: bea, who does not pull ada, finds the news at her door, and the card is ada's post", async () => {
        await beat(HOST, "outbox");
        let rows = [];
        for (let i = 0; i < 30 && rows.length === 0; i++) {
            rows = await rowsFor();
            if (rows.length === 0) await wait(400);
        }
        assert.equal(rows.length, 1, "the mention rang bea's bell");
        assert.equal(rows[0].doc_id, post, "naming ada's post, not one of bea's");
        assert.equal(rows[0].stranger, true, "by envelope");
        assert.equal(rows[0].doc_title, undefined, "the bell does not join the title from bea's own shelf");
    });

    it("the derived road: once bea follows ada the fold speaks, the roads dedupe, and the row wears ada's name", async function () {
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        let rows = [];
        for (let i = 0; i < 12 && !(rows.length === 1 && !rows[0].stranger); i++) {
            await beat(HOST_B, "pull", adaRoot);
            await beat(HOST_B, "fold", adaRoot);
            rows = await rowsFor();
        }
        assert.equal(rows.length, 1, "one row, the roads dedupe");
        assert.ok(!rows[0].stranger, "derived from a followed chain");
        assert.equal(rows[0].author_name, "Ada Mentions");
        assert.equal(rows[0].doc_id, post);
    });

    it("an edit that drops the card takes the mention back, and the row goes with it", async () => {
        const got = await (await ada(`api/identity/${adaRoot}/docs/${draft}`)).json();
        const edit = await j(ada, `api/identity/${adaRoot}/docs/${draft}`, {
            title: got.title, body: "a word for nobody in particular", parents: got.heads.map((h) => h.version), format: "marquee",
        }, "PUT");
        assert.equal(edit.status, 200, await edit.text());
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${draft}/publish`, {});
        assert.equal(pub.status, 200, await pub.text());
        assert.deepEqual(await mentionsOn(ada, adaRoot, post), [], "the statement is retracted on ada's chain");
        let rows = [];
        for (let i = 0; i < 12; i++) {
            await beat(HOST_B, "pull", adaRoot);
            await beat(HOST_B, "fold", adaRoot);
            rows = await rowsFor();
            if (rows.length === 0) break;
            await wait(300);
        }
        assert.equal(rows.length, 0, "the derived row recedes with the retraction");
    });
});
