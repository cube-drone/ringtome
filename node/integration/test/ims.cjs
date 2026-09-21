/*
    Private chats (CHAT.md, ruling 12, 2026-09-20): a room sealed to exactly one other
    person. Ada opens one with bea from bea's page; it is an IM on the signed header, sealed
    to bea and nobody else, and the pair talk in it. Opening a chat with somebody who already
    has one with you opens THEIRS, so there is one chat per pair whichever side minted it.
    The powers a room has are refused here: no mute, no badge, no close, no delete - and a
    room that claims to be an IM without being sealed to exactly one person does not mint.
    Both sides keep it whole: each node says it is the chat's archive.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C, sql } = require("./fetch.cjs");
const { withUnplugged } = require("./unplug.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)("IMs: a room sealed to one person", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, dee, deeRoot, speakable, chat, knock;

    // What the client's `openIm` does when the node says there is no chat yet: a room whose
    // words are a user card naming the other person, sealed to the people mentioned.
    const openIm = async (who, root, them, extra = {}) => {
        const body = `[user id=/id/${speakable(them)}]them[/user]`;
        const d = await (await j(who, `api/identity/${root}/docs`, { title: "a chat", body, format: "marquee" })).json();
        await who(`api/identity/${root}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, {
            room: true,
            im: true,
            trusted_only: true,
            audience: "@mentioned",
            ...extra,
        });
        return { status: pub.status, text: await pub.text(), draft: d.doc_id };
    };
    const rooms = async (who, root) => ((await (await who(`api/identity/${root}/rooms`)).json()).items || []);
    const enter = async (who, root, author, doc, tries = 40) => {
        for (let i = 0; i < tries; i++) {
            const r = await who(`api/identity/${root}/rooms/${author}/${doc}`);
            if (r.status === 200) return r.json();
            await pullAndFold(HOST_B, author);
            await wait(400);
        }
        return null;
    };

    before(async function () {
        ({ speakable } = await import("../../js/speakable.js"));
        ada = await makeUserFetch({ prefix: "imada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "imbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "imcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        // Bea follows ada, which is how the chat's post reaches her; cal follows her too,
        // and is admitted to nothing, because a seal for one person admits one person.
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        if ((await cal(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(cal, `api/identity/${calRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        // Dee is a stranger both ways: she does not follow ada, ada does not trust her, and
        // ada has only been to her page - which is where the chat button is.
        dee = await makeUserFetch({ prefix: "imdee", host: HOST_C });
        deeRoot = (await (await dee("api/identity", { method: "POST" })).json()).root_pubkey;
        await dee(`api/identity/${deeRoot}/serve`, { method: "POST" });
        await ada(`api/id/${deeRoot}/profile?via=${await base58(dee)}`);
        await beat(HOST, "mint", adaRoot);
    });

    it("a chat for two mints as an IM, sealed to the other person and nobody else", async () => {
        const made = await openIm(ada, adaRoot, beaRoot);
        assert.equal(made.status, 200, made.text);
        chat = JSON.parse(made.text).post_id;
        const mine = (await rooms(ada, adaRoot)).find((r) => r.doc_id === chat);
        assert.ok(mine, "it lists among ada's chats");
        assert.equal(mine.im, true, "as an IM");
        assert.equal(mine.other, beaRoot, "with bea on the other end");
        assert.equal(mine.trusted_only, true, "sealed");
        assert.ok(!mine.onward, "and never onward - an IM does not travel");
    });

    it("a room claiming to be an IM without a pair does not mint", async () => {
        const nobody = await openIm(ada, adaRoot, beaRoot, { audience: "" });
        assert.equal(nobody.status, 400, nobody.text);
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, {
            title: "a crowd",
            body: `[user id=/id/${speakable(beaRoot)}]bea[/user] [user id=/id/${speakable(calRoot)}]cal[/user]`,
            format: "marquee",
        })).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const two = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
            room: true,
            im: true,
            trusted_only: true,
            audience: "@mentioned",
        });
        assert.equal(two.status, 400, await two.text());
    });

    it("the other person finds it in their own chats, without being trusted or told", async () => {
        // Curtis, 2026-09-20: they follow each other and neither trusts the other, which is
        // the ordinary case for a chat somebody opens with you.
        let row = null;
        for (let i = 0; i < 40 && !row; i++) {
            await pullAndFold(HOST_B, adaRoot);
            for (let k = 0; k < 2; k++) await beat(HOST_B, "journal-fill");
            row = (await rooms(bea, beaRoot)).find((r) => r.doc_id === chat);
            if (!row) await wait(400);
        }
        assert.ok(row, "the chat lists among bea's own chats");
        assert.equal(row.im, true, `as an IM: ${JSON.stringify(row)}`);
        assert.equal(row.other, adaRoot, "with ada on the other end");
    });

    it("the first word arrives even when the sayer's push misses: the creator asks whoever the seal admits", async () => {
        // The push a say makes tries the first endpoint that answers, once. If that misses,
        // the creator's node has nobody to ask: its directory lists the people it has already
        // heard from, which at the FIRST word is nobody (Curtis, 2026-09-20, a chat whose
        // opening line never landed). It knows who the seal admits; that is who it asks, at
        // the address its own node reached them at, showing the room's key at their door -
        // which a chat for two answers to, its audience being the one size that cannot change.
        // Here bea says the chat's first word with her node dead to the network, so no push
        // of hers can land, and every road but the creator's own asking is shut.
        await withUnplugged([HOST_B], async () => {
            const said = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${chat}/messages`, { words: "said into a partition" });
            assert.equal(said.status, 200, await said.text());
        });
        let heard = [];
        for (let i = 0; i < 60 && !heard.includes("said into a partition"); i++) {
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/sync`, { method: "POST" });
            await beat(HOST, "fold", adaRoot);
            heard = ((await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages`)).json()).items || []).map((m) => m.words);
            if (!heard.includes("said into a partition")) await wait(400);
        }
        assert.ok(heard.includes("said into a partition"), `ada's node went and asked: ${JSON.stringify(heard)}`);
    });

    it("the other person enters it as an IM with the one who opened it, and talks", async () => {
        const hers = await enter(bea, beaRoot, adaRoot, chat);
        assert.ok(hers, "the door admits her");
        assert.equal(hers.im, true, `and says it is a private chat: ${JSON.stringify(hers)}`);
        assert.equal(hers.other, adaRoot, "whose other half is ada");
        assert.equal(hers.archivist, true, "her node keeps the whole of it");
        const said = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${chat}/messages`, { words: "hello, just us" });
        assert.equal(said.status, 200, await said.text());
        // Both ends push: bea's node sends her chain to the room's creator and ada's pulls
        // it, because under a full suite's load either half alone can be the slow one.
        let heard = [];
        const said_it = () => heard.some((m) => m.words === "hello, just us");
        for (let i = 0; i < 80 && !said_it(); i++) {
            await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${chat}/sync`, { method: "POST" });
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/sync`, { method: "POST" });
            await beat(HOST, "fold", adaRoot);
            heard = ((await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages`)).json()).items || []);
            if (!said_it()) await wait(400);
        }
        assert.ok(heard.map((m) => m.words).includes("hello, just us"), `ada hears her: ${JSON.stringify(heard.map((m) => m.words))}`);
        // The history door says what kind of room it is, because the feed's room card reads
        // it too and veils a stranger's picture by that answer (Curtis, 2026-09-20).
        const page = await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages?limit=3`)).json();
        assert.equal(page.im, true, `the door says it is a chat for two: ${JSON.stringify(page)}`);
        const mine = await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}`)).json();
        assert.equal(mine.archivist, true, "and her node keeps the whole of it too");
    });

    it("a word said in a private chat rings the other person's bell, trusted or not", async () => {
        // Curtis, 2026-09-20: every word in a chat for two is addressed to the other
        // person, so it names them - and the room mention is the one notice the follow-edge
        // rule exempts, which is what makes it arrive without waiting on anything.
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages`, { words: "are you there?" });
        assert.equal(said.status, 200, await said.text());
        let row = null;
        for (let i = 0; i < 40 && !row; i++) {
            await beat(HOST, "outbox").catch(() => {});
            const page = await (await bea(`api/identity/${beaRoot}/notifications`)).json();
            row = (page.items || []).find((n) => n.doc_id === chat && n.kind === "room-mention");
            if (!row) await wait(400);
        }
        assert.ok(row, "the bell rings, naming the chat");
        assert.equal(row.author, adaRoot, "and who said it");
    });

    it("a chat from a stranger is a REQUEST: its own pile, no bell, nothing synced until it is accepted", async () => {
        // Nothing of ada's reaches dee by any pull - she follows nothing of hers - so the
        // notice is the only road, and the door is the only thing that can ask for the key.
        const made = await openIm(ada, adaRoot, deeRoot);
        assert.equal(made.status, 200, made.text);
        knock = JSON.parse(made.text).post_id;
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${knock}/messages`, { words: "hello, stranger" });
        assert.equal(said.status, 200, await said.text());
        // The chat reaches her column as a request - the inbox is its only road, since she
        // pulls nothing of ada's - and her bell stays quiet: nobody has agreed to talk yet.
        let row = null;
        for (let i = 0; i < 40 && !row; i++) {
            await beat(HOST, "outbox").catch(() => {});
            row = (await rooms(dee, deeRoot)).find((r) => r.doc_id === knock);
            if (!row) await wait(400);
        }
        assert.ok(row, "it lists for somebody who follows nothing of ada's");
        assert.equal(row.request, true, `as a request: ${JSON.stringify(row)}`);
        assert.equal(row.im, true);
        assert.equal(row.other, adaRoot);
        const bell = await (await dee(`api/identity/${deeRoot}/notifications`)).json();
        assert.ok(!(bell.items || []).some((n) => n.doc_id === knock), `and rings nothing: ${JSON.stringify(bell.items)}`);
        // Looking at a request is not accepting it: the words come, the obligation does not.
        let entered = null;
        for (let i = 0; i < 30 && !entered; i++) {
            const r = await dee(`api/identity/${deeRoot}/rooms/${adaRoot}/${knock}`);
            if (r.status === 200) entered = await r.json();
            else await wait(400);
        }
        assert.ok(entered, "the door admits her - the key lane asked ada's node, which knows the audience");
        assert.equal(entered.request, true, `still a request: ${JSON.stringify(entered)}`);
        assert.equal(entered.joined, false, "not joined by looking");
        const open = Number((await sql(`SELECT COUNT(*) AS n FROM rooms_open WHERE root_pubkey = '${deeRoot}' AND room_doc = '${knock}'`, HOST_C)).rows[0].n);
        assert.equal(open, 0, "and not on the sync beat");
        let heard = [];
        for (let i = 0; i < 80 && heard.length === 0; i++) {
            await beat(HOST_C, "fold", deeRoot);
            heard = ((await (await dee(`api/identity/${deeRoot}/rooms/${adaRoot}/${knock}/messages`)).json()).items || []);
            if (heard.length === 0) {
                await dee(`api/identity/${deeRoot}/rooms/${adaRoot}/${knock}`);
                await wait(400);
            }
        }
        assert.deepEqual(heard.map((m) => m.words), ["hello, stranger"], "she reads what was said to her, to judge it");
    });

    it("answering a request accepts it: the chat files with the rest, and rings from then on", async () => {
        const said = await j(dee, `api/identity/${deeRoot}/rooms/${adaRoot}/${knock}/messages`, { words: "hello yourself" });
        assert.equal(said.status, 200, await said.text());
        const row = (await rooms(dee, deeRoot)).find((r) => r.doc_id === knock);
        assert.ok(row && !row.request, `no longer a request: ${JSON.stringify(row)}`);
        const open = Number((await sql(`SELECT COUNT(*) AS n FROM rooms_open WHERE root_pubkey = '${deeRoot}' AND room_doc = '${knock}'`, HOST_C)).rows[0].n);
        assert.equal(open, 1, "and on the sync beat now");
        let bell = [];
        for (let i = 0; i < 40 && bell.length === 0; i++) {
            const more = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${knock}/messages`, { words: "hello again" });
            assert.equal(more.status, 200, await more.text());
            await beat(HOST, "outbox").catch(() => {});
            const page = await (await dee(`api/identity/${deeRoot}/notifications`)).json();
            bell = (page.items || []).filter((n) => n.doc_id === knock);
            if (bell.length === 0) await wait(400);
        }
        assert.ok(bell.length > 0, "a word in an accepted chat rings");
    });

    it("a chat this computer has never asked about still lists: the door's judgement, not the feed's", async () => {
        // The state bea's node is in before anything of hers has asked ada's node for the
        // key: no grant, no key, no refusal. The feed's gate can only say no here - away
        // from ada's node an audience of one is unknowable - so the list has to ask.
        for (const q of [
            `DELETE FROM post_key_grants WHERE author_root = '${adaRoot}' AND doc_id = '${chat}'`,
            `DELETE FROM post_keys WHERE author_root = '${adaRoot}' AND doc_id = '${chat}'`,
            `DELETE FROM post_key_refusals WHERE author_root = '${adaRoot}' AND doc_id = '${chat}'`,
        ]) {
            await sql(q, HOST_B);
        }
        const row = (await rooms(bea, beaRoot)).find((r) => r.doc_id === chat);
        assert.ok(row, "the chat still lists - the key lane was asked, and ada's node knows the audience");
        assert.equal(row.im, true);
    });

    it("one chat per pair: either side asking for the chat with the other gets this one", async () => {
        const hers = await (await ada(`api/identity/${adaRoot}/ims/${beaRoot}`)).json();
        assert.deepEqual(hers, { author: adaRoot, doc_id: chat }, "ada's own chat with bea");
        let theirs = null;
        for (let i = 0; i < 40 && !theirs; i++) {
            const r = await bea(`api/identity/${beaRoot}/ims/${adaRoot}`);
            if (r.status === 200) theirs = await r.json();
            else await wait(400);
        }
        assert.deepEqual(theirs, { author: adaRoot, doc_id: chat }, "and bea is pointed at ada's, not a second one");
        const none = await ada(`api/identity/${adaRoot}/ims/${calRoot}`);
        assert.equal(none.status, 404, "with cal there is no chat yet");
    });

    it("a third person is not in it, however much of ada's they follow", async () => {
        await pullAndFold(HOST_C, adaRoot);
        for (let i = 0; i < 4; i++) {
            const r = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${chat}`);
            assert.notEqual(r.status, 200, `cal is refused: ${await r.text()}`);
            await wait(300);
        }
    });

    it("nobody mutes, deputizes, closes or deletes a private chat", async () => {
        const muted = await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/mutes/${beaRoot}`, { method: "POST" });
        assert.equal(muted.status, 400, await muted.text());
        const badge = await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/deputies/${beaRoot}`, { method: "POST" });
        assert.equal(badge.status, 400, await badge.text());
        const docs = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs || [];
        const draft = docs.find((x) => (x.fields || {}).published_as === chat);
        assert.ok(draft, "the chat's draft is a note in the chat bucket");
        const closed = await j(ada, `api/identity/${adaRoot}/docs/${draft.doc_id}/publish`, { settled: true });
        assert.equal(closed.status, 400, await closed.text());
        const gone = await ada(`api/identity/${adaRoot}/posts/${chat}`, { method: "DELETE" });
        assert.equal(gone.status, 400, await gone.text());
        // And it is still there, with its words in it.
        const still = await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}`)).json();
        assert.equal(still.im, true);
        assert.ok(!still.closed, "not closed");
    });
});
