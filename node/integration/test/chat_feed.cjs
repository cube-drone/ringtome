/*
    A room in the feed (Curtis, 2026-09-18): a room takes no replies and does not copy into
    notes - the conversation is inside it - and a busy room cycles in the feed: its feed
    time is its last word's, moved by the room pulse rather than per word. A reader who only
    follows the creator, never entered the room, still sees it move: the pulse asks the
    creator's node for the newest line.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C, sql } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("a room in the feed: no replies, no copies, and a busy room cycles", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, room, later;

    const publish = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        await who(`api/identity/${root}/docs/${d.doc_id}/buckets/${extra.room ? "chat" : "feed"}`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return { post: JSON.parse(text).post_id, draft: d.doc_id };
    };
    const feed = async (who, root) => ((await (await who(`api/identity/${root}/feed`)).json()).items || []);
    const feedRow = async (who, root, doc, tries = 30) => {
        for (let i = 0; i < tries; i++) {
            const row = (await feed(who, root)).find((r) => r.doc_id === doc);
            if (row) return row;
            await pullAndFold(HOST_B, adaRoot);
            await wait(300);
        }
        return null;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "feedada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "feedbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        ({ post: room } = await publish(ada, adaRoot, "the parlour", "where the talk is", { room: true }));
        await wait(20);
        ({ post: later } = await publish(ada, adaRoot, "a later word", "said after the room opened"));
        await pullAndFold(HOST_B, adaRoot);
    });

    it("a room takes no replies, and does not copy into notes", async () => {
        const d = await (await j(bea, `api/identity/${beaRoot}/docs`, { title: "", body: "a reply to the room", format: "marquee" })).json();
        await bea(`api/identity/${beaRoot}/docs/${d.doc_id}/buckets/feed`, { method: "PUT" });
        const reply = await j(bea, `api/identity/${beaRoot}/docs/${d.doc_id}/publish`, { reply_to: { author: adaRoot, doc_id: room } });
        assert.equal(reply.status, 400, await reply.text());
        const copy = await j(bea, `api/identity/${beaRoot}/docs/copy`, { author: adaRoot, doc_id: room, bucket: "clippings", new: true });
        assert.equal(copy.status, 400, await copy.text());
    });

    it("a busy room cycles in the feed: its feed time becomes its last word's, by the pulse, without entering it", async () => {
        const before = await feedRow(bea, beaRoot, room);
        assert.ok(before, "the room is in bea's feed");
        const laterRow = await feedRow(bea, beaRoot, later);
        assert.ok(laterRow, "and so is the later post");
        assert.ok(laterRow.published_ms >= before.published_ms, "the later post sits above the room at first");
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "is anyone about?" });
        const saidText = await said.text();
        assert.equal(said.status, 200, saidText);
        const saidMs = JSON.parse(saidText).said_ms;
        assert.ok(saidMs > laterRow.published_ms, "the word came after the later post");
        // Bea never entered the room: her node holds none of its chains, and the pulse asks
        // ada's node for the newest line.
        await beat(HOST_B, "room-pulse");
        const after = await feedRow(bea, beaRoot, room);
        assert.equal(after.published_ms, saidMs, `the room's feed time is its last word's: ${JSON.stringify(after)}`);
        const items = await feed(bea, beaRoot);
        const roomAt = items.findIndex((r) => r.doc_id === room);
        const laterAt = items.findIndex((r) => r.doc_id === later);
        assert.ok(roomAt >= 0 && roomAt < laterAt, "the room now sits above the later post");
        // The card's tail: the last three lines, newest first, with when.
        for (const w of ["two", "three", "four"]) {
            const r = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: w });
            assert.equal(r.status, 200, await r.text());
            await wait(5);
        }
        const tail = await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages?limit=3`)).json();
        assert.deepEqual((tail.items || []).map((m) => m.words), ["four", "three", "two"], `the tail is the last three: ${JSON.stringify(tail)}`);
        assert.ok(tail.items.every((m) => m.said_ms > 0), "each with when");
        assert.equal(tail.total, 4, `and the room's size, for "and N more": ${JSON.stringify(tail)}`);
    });

    it("leaving a room lists it beneath the active ones, never bold and no longer synced; a look is not a rejoin; rejoining is", async () => {
        const rooms = async () => ((await (await bea(`api/identity/${beaRoot}/rooms`)).json()).items || []);
        const opened = async () => Number((await sql(`SELECT COUNT(*) AS n FROM rooms_open WHERE root_pubkey = '${beaRoot}' AND room_doc = '${room}'`, HOST_B)).rows[0].n);
        let entered = null;
        for (let i = 0; i < 30 && !entered; i++) {
            const r = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`);
            if (r.status === 200) entered = await r.json();
            else await wait(400);
        }
        assert.ok(entered && entered.joined && !entered.left, `bea is in the parlour: ${JSON.stringify(entered)}`);
        assert.equal(await opened(), 1, "the node keeps the room pulled");
        const left = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`, { method: "DELETE" });
        assert.equal(left.status, 200, await left.text());
        assert.equal(await opened(), 0, "the node stops pulling a left room");
        const saidAfter = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "after bea left" });
        assert.equal(saidAfter.status, 200, await saidAfter.text());
        let list = await rooms();
        let row = list.find((r) => r.doc_id === room);
        assert.ok(row && row.left, `the parlour is listed as left: ${JSON.stringify(row)}`);
        assert.equal(!!row.unread, false, "a left room is never bold");
        assert.ok(list.findIndex((r) => r.doc_id === room) >= list.filter((r) => !r.left).length, "and sits beneath every active room");
        const look = await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`)).json();
        assert.equal(look.left, true, `a look at a left room says so: ${JSON.stringify(look)}`);
        assert.equal(await opened(), 0, "and does not rejoin it");
        const rejoined = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/join`, { method: "POST" });
        assert.equal(rejoined.status, 200, await rejoined.text());
        assert.equal(await opened(), 1, "the node pulls the room again");
        for (let i = 0; i < 30; i++) {
            await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST_B, "fold", adaRoot);
            list = await rooms();
            row = list.find((r) => r.doc_id === room);
            if (row && !row.left && row.unread) break;
            await wait(300);
        }
        assert.ok(row && !row.left && row.joined, `active again: ${JSON.stringify(row)}`);
        assert.equal(row.unread, true, "and bold, with what was said while bea was away");
    });

    it("a message naming a persona rings their bell, with the room as the object; a left room rings nothing", async () => {
        const { speakable } = await import("../../js/speakable.js");
        const rows = async () => ((await (await bea(`api/identity/${beaRoot}/notifications`)).json()).items || []).filter((i) => i.kind === "room-mention" && i.author === adaRoot);
        // Bea FOLLOWS ada: the envelope road still rings, since no fold reads a room chain.
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: `[user id=/id/${speakable(beaRoot)}]bea[/user] are you there?` });
        assert.equal(said.status, 200, await said.text());
        await beat(HOST, "outbox");
        let found = [];
        for (let i = 0; i < 30 && found.length === 0; i++) {
            found = await rows();
            if (found.length === 0) await wait(400);
        }
        assert.equal(found.length, 1, `the mention rang bea's bell: ${JSON.stringify(found)}`);
        assert.equal(found[0].doc_id, room, "naming the room");
        assert.equal(found[0].detail, adaRoot, "and its author - the room's address");
        assert.equal(found[0].doc_title, "the parlour", "worn as the room's name");
        const before = found[0].updated_ms;
        // Left: the next mention is accepted at the door and kept nowhere.
        const left = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`, { method: "DELETE" });
        assert.equal(left.status, 200, await left.text());
        const again = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: `[user id=/id/${speakable(beaRoot)}]bea[/user] still there?` });
        assert.equal(again.status, 200, await again.text());
        await beat(HOST, "outbox");
        await wait(1500);
        const after = await rows();
        assert.equal(after.length, 1, "no second row");
        assert.equal(after[0].updated_ms, before, "and the one row did not move: a left room rings nothing");
    });

    it("the chat badge counts what others said in active rooms since the last look, off the live stream", async () => {
        const WebSocket = require("ws");
        const cookie = bea.jar.getCookieStringSync(`http://${HOST_B}/`);
        // One frame: a fresh socket's snapshot carries the count as the bell's.
        const snapshot = () =>
            new Promise((resolve, reject) => {
                const ws = new WebSocket(`ws://${HOST_B}/api/identity/${beaRoot}/stream`, { headers: { Cookie: cookie } });
                const timer = setTimeout(() => { ws.close(); reject(new Error("no snapshot within 10s")); }, 10000);
                ws.on("message", (data) => { clearTimeout(timer); ws.close(); resolve(JSON.parse(data.toString())); });
                ws.on("error", reject);
            });
        const latest = async () => (((await (await bea(`api/identity/${beaRoot}/rooms`)).json()).items || []).find((r) => r.doc_id === room) || {}).latest_ms || 0;
        // Back in, and caught up: the look is the newest word.
        assert.equal((await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/join`, { method: "POST" })).status, 200);
        await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
        await beat(HOST_B, "fold", adaRoot);
        await j(bea, `api/identity/${beaRoot}/private/kv/rooms_seen/${adaRoot}:${room}`, { value: String(await latest()) }, "PUT");
        assert.equal((await snapshot()).unread_chat, 0, "caught up: nothing unseen");
        for (const w of ["one for the badge", "two for the badge"]) {
            const r = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: w });
            assert.equal(r.status, 200, await r.text());
            await wait(5);
        }
        let frame = null;
        for (let i = 0; i < 30; i++) {
            await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST_B, "fold", adaRoot);
            frame = await snapshot();
            if (frame.unread_chat === 2) break;
            await wait(300);
        }
        assert.equal(frame.unread_chat, 2, `two words said since the look: ${JSON.stringify(frame.unread_chat)}`);
        // The look clears it; bea's own words never count.
        await j(bea, `api/identity/${beaRoot}/private/kv/rooms_seen/${adaRoot}:${room}`, { value: String(await latest()) }, "PUT");
        const mine = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "my own word" });
        assert.equal(mine.status, 200, await mine.text());
        assert.equal((await snapshot()).unread_chat, 0, "looked, and one's own words are not unseen");
    });

    it("an emoji said in answer to a line stacks under it - once per person per emoji, most-said first, with who - and is no line itself", async () => {
        const history = async (who, root) => (await (await who(`api/identity/${root}/rooms/${adaRoot}/${room}/messages`)).json());
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "react to this" });
        assert.equal(said.status, 200, await said.text());
        let line = null;
        for (let i = 0; i < 30 && !line; i++) {
            await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST_B, "fold", adaRoot);
            line = (await history(bea, beaRoot)).items.find((m) => m.words === "react to this");
            if (!line) await wait(300);
        }
        assert.ok(line, "bea sees the line");
        // Bea twice with one emoji (counts once), ada with two; a word is not a reaction;
        // a line nobody holds cannot be answered.
        for (const [who, root, code] of [[bea, beaRoot, ":+1:"], [bea, beaRoot, ":+1:"], [ada, adaRoot, ":+1:"], [ada, adaRoot, ":heart:"]]) {
            const r = await j(who, `api/identity/${root}/rooms/${adaRoot}/${room}/messages`, { words: code, reacts_to: line.hash });
            assert.equal(r.status, 200, await r.text());
        }
        const notEmoji = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "thumbs up", reacts_to: line.hash });
        assert.equal(notEmoji.status, 400, await notEmoji.text());
        const nowhere = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: ":+1:", reacts_to: "ab".repeat(32) });
        assert.equal(nowhere.status, 404, await nowhere.text());
        // On ada's node, the directory of record, once bea's chain lands.
        let stacked = null;
        for (let i = 0; i < 30; i++) {
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST, "fold", beaRoot);
            const h = await history(ada, adaRoot);
            const l = h.items.find((m) => m.hash === line.hash);
            if (l && (l.reactions || []).some((r) => r.emoji === ":+1:" && r.count === 2)) {
                stacked = { h, l };
                break;
            }
            await wait(300);
        }
        assert.ok(stacked, "the stacks assembled on ada's node");
        assert.deepEqual(stacked.l.reactions.map((r) => [r.emoji, r.count]), [[":+1:", 2], [":heart:", 1]], `most-said first: ${JSON.stringify(stacked.l.reactions)}`);
        assert.deepEqual(stacked.l.reactions[0].who.map((w) => w.root).sort(), [adaRoot, beaRoot].sort(), "who said the thumbs");
        assert.ok(!stacked.h.items.some((m) => m.words === ":+1:" || m.words === ":heart:"), "a reaction is no line of its own");
        // Taken back: bea withdraws her thumb, and it stops counting once her chain lands;
        // said again, it counts again. Taking back what one never said is refused.
        const back = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: ":+1:", reacts_to: line.hash, retract: true });
        assert.equal(back.status, 200, await back.text());
        const never = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: ":heart:", reacts_to: line.hash, retract: true });
        assert.equal(never.status, 404, await never.text());
        const stackOf = async (who, root, emoji) => (((await history(who, root)).items.find((m) => m.hash === line.hash) || {}).reactions || []).find((r) => r.emoji === emoji);
        let thumbs = null;
        for (let i = 0; i < 30; i++) {
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST, "fold", beaRoot);
            thumbs = await stackOf(ada, adaRoot, ":+1:");
            if (thumbs && thumbs.count === 1) break;
            await wait(300);
        }
        assert.ok(thumbs && thumbs.count === 1 && thumbs.who[0].root === adaRoot, `bea's thumb is withdrawn on ada's node: ${JSON.stringify(thumbs)}`);
        const again = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: ":+1:", reacts_to: line.hash });
        assert.equal(again.status, 200, await again.text());
        for (let i = 0; i < 30; i++) {
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST, "fold", beaRoot);
            thumbs = await stackOf(ada, adaRoot, ":+1:");
            if (thumbs && thumbs.count === 2) break;
            await wait(300);
        }
        assert.equal(thumbs && thumbs.count, 2, "said again, it counts again");
    });

    it("a line edits and deletes by later entries: the newest words stand in its place, marked; a deleted line leaves the floor; only one's own lines change", async () => {
        const history = async (who, root) => (await (await who(`api/identity/${root}/rooms/${adaRoot}/${room}/messages`)).json());
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "a typo hear" });
        assert.equal(said.status, 200, await said.text());
        const mine = (await history(ada, adaRoot)).items.find((m) => m.words === "a typo hear");
        assert.ok(mine, "the line is on ada's floor");
        // A reaction first, so the edit can be seen to keep it - once bea's node holds the line.
        let seen = false;
        for (let i = 0; i < 30 && !seen; i++) {
            await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST_B, "fold", adaRoot);
            seen = (await history(bea, beaRoot)).items.some((m) => m.hash === mine.hash);
            if (!seen) await wait(300);
        }
        assert.ok(seen, "bea holds the line");
        const eyes = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: ":eyes:", reacts_to: mine.hash });
        assert.equal(eyes.status, 200, await eyes.text());
        // Not bea's to change.
        const notHers = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "a typo here", edits: mine.hash });
        assert.equal(notHers.status, 404, await notHers.text());
        // Edited: the same hash, the new words, marked, at the old place; the count unchanged.
        const before = (await history(ada, adaRoot)).total;
        const edited = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "a typo here", edits: mine.hash });
        assert.equal(edited.status, 200, await edited.text());
        let h = await history(ada, adaRoot);
        let line = h.items.find((m) => m.hash === mine.hash);
        assert.ok(line && line.words === "a typo here" && line.edited === true && line.said_ms === mine.said_ms, `edited in place: ${JSON.stringify(line)}`);
        assert.ok(!h.items.some((m) => m.words === "a typo hear"), "the old words are gone from the floor");
        assert.equal(h.total, before, "an edit is no new line");
        // Bea's node, once ada's chain lands: the same, reaction kept.
        for (let i = 0; i < 30; i++) {
            await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST_B, "fold", adaRoot);
            line = (await history(bea, beaRoot)).items.find((m) => m.hash === mine.hash);
            if (line && line.words === "a typo here") break;
            await wait(300);
        }
        assert.ok(line && line.edited, `bea sees the edit: ${JSON.stringify(line)}`);
        for (let i = 0; i < 30 && !(line.reactions || []).some((r) => r.emoji === ":eyes:"); i++) {
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST, "fold", beaRoot);
            line = (await history(ada, adaRoot)).items.find((m) => m.hash === mine.hash);
            await wait(300);
        }
        assert.ok((line.reactions || []).some((r) => r.emoji === ":eyes:"), "the reaction rides the line through the edit");
        // Deleted: gone from ada's floor and, once landed, from bea's; the count drops; twice is refused.
        const gone = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "", deletes: mine.hash });
        assert.equal(gone.status, 200, await gone.text());
        h = await history(ada, adaRoot);
        assert.ok(!h.items.some((m) => m.hash === mine.hash), "deleted from ada's floor");
        assert.equal(h.total, before - 1, "and the count drops");
        const twice = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "", deletes: mine.hash });
        assert.equal(twice.status, 400, await twice.text());
        let still = true;
        for (let i = 0; i < 30 && still; i++) {
            await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST_B, "fold", adaRoot);
            still = (await history(bea, beaRoot)).items.some((m) => m.hash === mine.hash);
            if (still) await wait(300);
        }
        assert.equal(still, false, "and from bea's");
    });

    it("the creator mutes a person: their words leave every floor, the room hears it said, and the roster sits them last until it is lifted", async () => {
        const history = async (who, root) => (await (await who(`api/identity/${root}/rooms/${adaRoot}/${room}/messages`)).json());
        const wordsOf = async (who, root) => ((await history(who, root)).items || []).map((m) => m.words);
        // Bea says something, and ada holds it.
        const said = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "bea speaks out of turn" });
        assert.equal(said.status, 200, await said.text());
        let heard = [];
        for (let i = 0; i < 30 && !heard.includes("bea speaks out of turn"); i++) {
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/sync`, { method: "POST" });
            await beat(HOST, "fold", beaRoot);
            heard = await wordsOf(ada, adaRoot);
            if (!heard.includes("bea speaks out of turn")) await wait(300);
        }
        assert.ok(heard.includes("bea speaks out of turn"), "ada hears her before the mute");
        // Only the creator moderates.
        const notHers = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/mutes/${adaRoot}`, { method: "POST" });
        assert.equal(notHers.status, 403, await notHers.text());
        // The mute: a label on the post, and a line in the room saying so.
        const muted = await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/mutes/${beaRoot}`, { method: "POST" });
        assert.equal(muted.status, 200, await muted.text());
        const after = await history(ada, adaRoot);
        assert.ok(!(after.items || []).some((m) => m.words === "bea speaks out of turn"), "her words left ada's floor");
        const notice = (after.items || []).find((m) => m.notice === "muted");
        assert.ok(notice && notice.notice_subject === beaRoot && notice.speaker === adaRoot, `the room heard it said: ${JSON.stringify(notice)}`);
        assert.equal((await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}`)).json()).muted[0], beaRoot, "the door names the muted");
        const roster = ((await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/chatters`)).json()).items || []);
        assert.equal(roster[roster.length - 1].root, beaRoot, "and the roster sits her last");
        assert.equal(roster[roster.length - 1].muted, true, "marked");
        // And her own door stands down with the composer (Curtis, 2026-09-20): once the mute
        // reaches her node, it will not put words on a chain no floor will show.
        let refused = null;
        for (let i = 0; i < 30 && !refused; i++) {
            await pullAndFold(HOST_B, adaRoot);
            const r = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "hello?" });
            if (r.status === 403) refused = await r.text();
            else await wait(300);
        }
        assert.ok(refused && /muted/.test(refused), `her own node refuses her, with the word: ${refused}`);
        assert.equal((await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`)).json()).muted[0], beaRoot, "and her door names her muted, so the page can say so");
        // The mute travels: bea's own node honours it once ada's labels land.
        let hers = await wordsOf(bea, beaRoot);
        for (let i = 0; i < 30 && hers.includes("bea speaks out of turn"); i++) {
            await pullAndFold(HOST_B, adaRoot);
            hers = await wordsOf(bea, beaRoot);
            if (hers.includes("bea speaks out of turn")) await wait(300);
        }
        assert.ok(!hers.includes("bea speaks out of turn"), `an honest node hides a muted speaker from every reader: ${JSON.stringify(hers)}`);
        // Lifted: her words come back, and the room hears that too.
        const lifted = await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/mutes/${beaRoot}`, { method: "DELETE" });
        assert.equal(lifted.status, 200, await lifted.text());
        const back = await history(ada, adaRoot);
        assert.ok((back.items || []).some((m) => m.words === "bea speaks out of turn"), "her words are on the floor again");
        assert.ok((back.items || []).some((m) => m.notice === "unmuted" && m.notice_subject === beaRoot), "and the room heard the lift");
    });

    it("the creator deputizes: the badge is said in the room, a deputy's mute counts as the creator's, and a deputy cannot pass the badge on", async () => {
        const history = async (who, root) => (await (await who(`api/identity/${root}/rooms/${adaRoot}/${room}/messages`)).json());
        const cal = await makeUserFetch({ prefix: "depcal", host: HOST_C });
        const calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        const { toBase58 } = await import("../../js/speakable.js");
        const via = toBase58((await (await ada("api/node")).json()).endpoint_id);
        if ((await cal(`api/id/${adaRoot}/profile?via=${via}`)).status !== 200) this.skip();
        // Cal enters the open room by link and says something ada can hear.
        let entered = null;
        for (let i = 0; i < 30 && !entered; i++) {
            const r = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${room}`);
            if (r.status === 200) entered = await r.json();
            else await wait(400);
        }
        assert.ok(entered, "cal is in the parlour");
        assert.equal((await j(cal, `api/identity/${calRoot}/rooms/${adaRoot}/${room}/messages`, { words: "cal is chatty" })).status, 200);
        // Before the badge, bea may not moderate.
        const tooSoon = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/mutes/${calRoot}`, { method: "POST" });
        assert.equal(tooSoon.status, 403, await tooSoon.text());
        // The badge: said on the post, and said in the room.
        const badge = await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/deputies/${beaRoot}`, { method: "POST" });
        assert.equal(badge.status, 200, await badge.text());
        const heard = await history(ada, adaRoot);
        assert.ok(
            (heard.items || []).some((m) => m.notice === "deputized" && m.notice_subject === beaRoot && m.speaker === adaRoot),
            `the room heard the badge: ${JSON.stringify((heard.items || []).map((m) => m.notice).filter(Boolean))}`
        );
        assert.deepEqual((await (await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}`)).json()).deputies, [beaRoot], "the door names the deputy");
        // Bea's mute now counts as ada's, on ada's own floor, once her labels land.
        for (let i = 0; i < 30; i++) {
            await pullAndFold(HOST_B, adaRoot);
            const r = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/mutes/${calRoot}`, { method: "POST" });
            if (r.status === 200) break;
            await wait(300);
        }
        let gone = false;
        for (let i = 0; i < 30 && !gone; i++) {
            await pullAndFold(HOST, beaRoot);
            const words = ((await history(ada, adaRoot)).items || []).map((m) => m.words);
            gone = !words.includes("cal is chatty");
            if (!gone) await wait(300);
        }
        assert.ok(gone, "a deputy's mute is honoured on the creator's own floor");
        // The badge stops with her: a deputy deputizes nobody, and does not mute the creator.
        const passed = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/deputies/${calRoot}`, { method: "POST" });
        assert.equal(passed.status, 403, await passed.text());
        const atTheCreator = await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}/mutes/${adaRoot}`, { method: "POST" });
        assert.equal(atTheCreator.status, 403, await atTheCreator.text());
        // Taken back: the room hears that too, and her word stops counting.
        const back = await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${room}/deputies/${beaRoot}`, { method: "DELETE" });
        assert.equal(back.status, 200, await back.text());
        const after = await history(ada, adaRoot);
        assert.ok((after.items || []).some((m) => m.notice === "undeputized" && m.notice_subject === beaRoot), "the room heard the badge come back");
        assert.ok(((after.items || []).map((m) => m.words)).includes("cal is chatty"), "and cal is heard again");
    });

    it("the owner closes the room (the record stands, nobody says more, and closed stays closed), then takes it down (it leaves every list)", async () => {
        const roomsOf = async (who, root) => ((await (await who(`api/identity/${root}/rooms`)).json()).items || []);
        // The room's own draft, by its publication: what the page finds on the mirror.
        const docs = await (await ada(`api/identity/${adaRoot}/docs`)).json();
        const draft = (docs.docs || []).find((d) => d.fields && d.fields.published_as === room);
        assert.ok(draft, "the room's draft is on ada's shelf");
        const closed = await j(ada, `api/identity/${adaRoot}/docs/${draft.doc_id}/publish`, { settled: true });
        assert.equal(closed.status, 200, await closed.text());
        const adaList = await roomsOf(ada, adaRoot);
        assert.equal(adaList.find((r) => r.doc_id === room).closed, true, "ada's list says closed");
        assert.equal(adaList[adaList.length - 1].doc_id, room, "and a closed room sits at the very bottom");
        await pullAndFold(HOST_B, adaRoot);
        assert.equal((await (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${room}`)).json()).closed, true, "bea's door says closed");
        const late = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${room}/messages`, { words: "too late" });
        assert.equal(late.status, 400, await late.text());
        // Closed stays closed (ruling 10): a re-publish carries the wish forward.
        const again = await j(ada, `api/identity/${adaRoot}/docs/${draft.doc_id}/publish`, { settled: false });
        assert.equal(again.status, 200, await again.text());
        assert.equal((await (await ada(`api/id/${adaRoot}/posts/${room}`)).json()).settled, true, "the wish is carried, never lifted");
        // Taken down: the post goes, and the room leaves the lists.
        const down = await ada(`api/identity/${adaRoot}/posts/${room}`, { method: "DELETE" });
        assert.equal(down.status, 200, await down.text());
        assert.ok(!(await roomsOf(ada, adaRoot)).some((r) => r.doc_id === room), "gone from ada's list");
        let still = true;
        for (let i = 0; i < 30 && still; i++) {
            await pullAndFold(HOST_B, adaRoot);
            still = (await roomsOf(bea, beaRoot)).some((r) => r.doc_id === room);
            if (still) await wait(300);
        }
        assert.equal(still, false, "and, once the tombstone lands, from bea's");
    });
});
