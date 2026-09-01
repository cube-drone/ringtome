/*
    VISIBILITY.md slice 1: the settled post. The flag is a wish carried in the signed
    header - malicious clients and screenshots exist - and every honest door here honors
    it: the reply publish refuses, the rebroadcast mint refuses, the thread door serves
    nothing, and the permalink says so.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

describe("settled posts: the author's wish, honored", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, settled, open;

    const publish = async (title, body, extra) => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title, body, format: "plaintext" }),
            })
        ).json();
        const pub = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
            ...(extra ? { body: JSON.stringify(extra) } : {}),
        });
        const text = await pub.text();
        return { status: pub.status, text, post: pub.status === 200 ? JSON.parse(text).post_id : null };
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: "setada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "setbea" });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
    });

    it("the flag rides the publish and the permalink says so", async () => {
        const made = await publish("quiet words", "said once", { settled: true });
        assert.equal(made.status, 200, made.text);
        settled = made.post;
        const head = await (await ada(`api/id/${adaRoot}/posts/${settled}`)).json();
        assert.equal(head.settled, true, "the permalink carries the wish");
        const control = await publish("open words", "say more", undefined);
        assert.equal(control.status, 200, control.text);
        open = control.post;
        const openHead = await (await ada(`api/id/${adaRoot}/posts/${open}`)).json();
        assert.ok(!openHead.settled, "absence means open");
    });

    it("a reply naming a settled parent is refused with words", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "", body: "but actually", format: "plaintext" }),
            })
        ).json();
        const pub = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
            body: JSON.stringify({ reply_to: { author: adaRoot, doc_id: settled } }),
        });
        const text = await pub.text();
        assert.equal(pub.status, 400, text);
        assert.match(text, /settled/, "the refusal has the word");
    });

    it("a rebroadcast of a settled post is refused; the open control passes along fine", async () => {
        // bea's node (this same node) holds ada's chains, so the header - and its wish -
        // is visible at the mint.
        const no = await bea(`api/identity/${beaRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: adaRoot, doc_id: settled }),
        });
        const noText = await no.text();
        assert.equal(no.status, 400, noText);
        assert.match(noText, /settled/);
        const yes = await bea(`api/identity/${beaRoot}/rebroadcasts`, {
            method: "POST",
            body: JSON.stringify({ author: adaRoot, doc_id: open }),
        });
        assert.equal(yes.status, 200, await yes.text());
    });

    it("the thread door is shut: the replies read serves nothing and says why", async () => {
        const page = await (await ada(`api/id/${adaRoot}/posts/${settled}/replies`)).json();
        assert.deepEqual(page.replies, [], "nothing served");
        assert.equal(page.settled, true, "and the reader is told why");
        assert.equal(page.seeking, false, "and nobody goes asking for more");
    });
});
