/*
    Media in rooms (CHAT.md, slice 5, ruling 11, 2026-09-18): a message never carries bytes,
    it carries references, and the say bakes them the way publication bakes a post's - the
    private picture becomes a public twin on the speaker's posts chain, the words are
    rewritten to it, and the message's refs name it. A reader who reached the room by link
    holds the speaker at room depth, no posts chain, so the twin travels as a fragment under
    the room's door: cover rows keyed by the message, the header over the fragment lane, the
    bytes behind it. Pruning the line releases its picture; the archive keeps it. A sealed
    room seals its twins under the room's key, so admission to the room is admission to the
    picture. Media from the open web is refused: a room says now.

    The rig runs every node with RINGTOME_TEST_ROOM_BUDGET=8 (justfile).
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch, makePng } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, HOST_C, sql } = require("./fetch.cjs");

const BUDGET = 8;

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const esc = (s) => s.replace(/'/g, "''");

(HOST_B && HOST_C ? describe : describe.skip)("media in rooms: the say bakes, the twin travels under the room's door", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, gallery, vault;

    const openRoom = async (who, root, title, body, extra = {}) => {
        const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
        await who(`api/identity/${root}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, { room: true, ...extra });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return JSON.parse(text).post_id;
    };
    const upload = async (who, root, title) => {
        const pic = await (await who(`api/identity/${root}/docs/binary?title=${title}`, { method: "POST", body: makePng(24, 24), file: true })).json();
        assert.ok(pic.doc_id, `the upload minted a document: ${JSON.stringify(pic)}`);
        await who(`api/identity/${root}/docs/${pic.doc_id}/buckets/chat`, { method: "PUT" });
        let landed = false;
        for (let i = 0; i < 60 && !landed; i++) {
            landed = (await who(`api/identity/${root}/docs/${pic.doc_id}/body`)).status === 200;
            if (!landed) await wait(300);
        }
        assert.ok(landed, "the picture finished ingesting");
        return pic.doc_id;
    };
    const enter = async (who, root, author, doc) => {
        for (let i = 0; i < 30; i++) {
            const r = await who(`api/identity/${root}/rooms/${author}/${doc}`);
            if (r.status === 200) return r.json();
            await wait(400);
        }
        return null;
    };
    const say = async (who, root, author, doc, words) => j(who, `api/identity/${root}/rooms/${author}/${doc}/messages`, { words });
    const history = async (who, root, author, doc) => (await (await who(`api/identity/${root}/rooms/${author}/${doc}/messages`)).json());
    const wordsOf = (h) => (h.items || []).map((m) => m.words);
    const readAfterSync = async (host, who, root, author, doc, test, tries = 30) => {
        let h = { items: [] };
        for (let i = 0; i < tries; i++) {
            await who(`api/identity/${root}/rooms/${author}/${doc}/sync`, { method: "POST" });
            await beat(host, "fold", author);
            h = await history(who, root, author, doc);
            if (test(h)) return h;
            await wait(400);
        }
        return h;
    };
    // The twin a said line points at: `/id/<author>/docs/<twin>/body/...`.
    const twinOf = (words, author) => {
        const m = words.match(new RegExp(`/id/${author}/docs/([0-9a-f]{32})/body`));
        return m && m[1];
    };
    // The reader's node fetches the twin off the room's memo fold, then its bytes behind it:
    // the body door answers 200 once both are here.
    const bodyArrives = async (host, who, author, twin, tries = 40) => {
        for (let i = 0; i < tries; i++) {
            const r = await who(`id/${author}/docs/${twin}/body`);
            if (r.status === 200) return r;
            await beat(host, "fold", author);
            await beat(host, "bodies-sweep");
            await wait(400);
        }
        return await who(`id/${author}/docs/${twin}/body`);
    };
    const fragmentsHeld = async (host, author, twin) => {
        const r = await sql(`SELECT COUNT(*) AS n FROM fragments WHERE author_root = '${esc(author)}' AND doc_id = '${esc(twin)}'`, host);
        return Number(r.rows[0].n);
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "mediaada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "mediabea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        cal = await makeUserFetch({ prefix: "mediacal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await j(ada, `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, { value: "high" }, "PUT");
        await beat(HOST, "mint", adaRoot);
        await pullAndFold(HOST, beaRoot);
        gallery = await openRoom(ada, adaRoot, "the gallery", "pictures on the wall");
        vault = await openRoom(ada, adaRoot, "the vault", "the pictures nobody else sees", { trusted_only: true });
        await pullAndFold(HOST_B, adaRoot);
    });

    it("a picture said in an open room is baked to a twin, and a reader by link gets it under the room's door", async function () {
        const seen = await cal(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
        if (seen.status !== 200) this.skip();
        const pic = await upload(ada, adaRoot, "wall");
        const said = await say(ada, adaRoot, adaRoot, gallery, `look at this\n\n![wall](/api/identity/${adaRoot}/docs/${pic}/body/wall.avif)`);
        assert.equal(said.status, 200, await said.text());
        const mine = await readAfterSync(HOST, ada, adaRoot, adaRoot, gallery, (h) => wordsOf(h).some((w) => w && w.includes("look at this")));
        const line = mine.items.find((m) => m.words.includes("look at this"));
        const twin = twinOf(line.words, adaRoot);
        assert.ok(twin, `the words were rewritten to the public twin: ${line.words}`);
        assert.ok(!line.words.includes("/api/identity/"), "no private reference survives the bake");
        assert.notEqual(twin, pic, "the twin is a new public document, not the private original");
        // The reader by link: cal holds ada at room depth, and the twin comes as a fragment.
        assert.ok(await enter(cal, calRoot, adaRoot, gallery), "cal is in the gallery");
        const his = await readAfterSync(HOST_C, cal, calRoot, adaRoot, gallery, (h) => wordsOf(h).some((w) => w && w.includes("look at this")));
        assert.ok(wordsOf(his).some((w) => w && w.includes(`/id/${adaRoot}/docs/${twin}/body`)), `cal reads the line as said: ${JSON.stringify(wordsOf(his))}`);
        const body = await bodyArrives(HOST_C, cal, adaRoot, twin);
        assert.equal(body.status, 200, `the twin's bytes reached cal's node: ${body.status} (fragments held: ${await fragmentsHeld(HOST_C, adaRoot, twin)})`);
        assert.ok((body.headers.get("content-type") || "").startsWith("image/"), `served as an image: ${body.headers.get("content-type")}`);
        assert.equal(await fragmentsHeld(HOST_C, adaRoot, twin), 1, "held as a fragment, covered by the line");
    });

    it("media from the open web is refused - a room says now", async () => {
        const said = await say(ada, adaRoot, adaRoot, gallery, "![elsewhere](https://example.com/pic.png)");
        assert.equal(said.status, 400, await said.text());
    });

    it("pruning the line releases its picture on the budgeted node; the creator's node keeps it", async () => {
        const before = await history(cal, calRoot, adaRoot, gallery);
        const line = before.items.find((m) => m.words && m.words.includes("look at this"));
        assert.ok(line, "the picture line stands before the flood");
        const twin = twinOf(line.words, adaRoot);
        for (let i = 1; i <= BUDGET + 1; i++) {
            const r = await say(ada, adaRoot, adaRoot, gallery, `flood ${i}`);
            assert.equal(r.status, 200, await r.text());
            await wait(5);
        }
        await readAfterSync(HOST_C, cal, calRoot, adaRoot, gallery, (h) => wordsOf(h).includes(`flood ${BUDGET + 1}`));
        // The floor still READS the line - the archive fills the page beneath the budget
        // (ruling 6) - but cal's node no longer keeps it, and its picture goes with it.
        const memo = await sql(`SELECT COUNT(*) AS n FROM room_messages WHERE room_doc = '${esc(gallery)}' AND entry_hash = X'${esc(line.hash)}'`, HOST_C);
        assert.equal(Number(memo.rows[0].n), 0, "the picture line fell beneath the budget on cal's node");
        assert.equal(await fragmentsHeld(HOST_C, adaRoot, twin), 0, "its twin went with it - nothing covers it now");
        // The archive keeps the line and the picture.
        const kept = await ada(`id/${adaRoot}/docs/${twin}/body`);
        assert.equal(kept.status, 200, "the creator's node still serves the twin");
    });

    it("a sealed room seals its twins under the room's key: the trusted reader opens the picture, the stranger cannot", async () => {
        const pic = await upload(ada, adaRoot, "safe");
        const said = await say(ada, adaRoot, adaRoot, vault, `![safe](/api/identity/${adaRoot}/docs/${pic}/body/safe.avif)`);
        assert.equal(said.status, 200, await said.text());
        assert.ok(await enter(bea, beaRoot, adaRoot, vault), "bea is in the vault");
        const hers = await readAfterSync(HOST_B, bea, beaRoot, adaRoot, vault, (h) => wordsOf(h).some((w) => w && w.includes(`/id/${adaRoot}/docs/`)));
        const line = hers.items.find((m) => m.words && m.words.includes(`/id/${adaRoot}/docs/`));
        assert.ok(line, `bea opens the sealed line: ${JSON.stringify(hers)}`);
        const twin = twinOf(line.words, adaRoot);
        const body = await bodyArrives(HOST_B, bea, adaRoot, twin);
        assert.equal(body.status, 200, `bea's node opens the sealed twin with the room's key: ${body.status}`);
        assert.ok((body.headers.get("content-type") || "").startsWith("image/"), "and it is the picture");
        // The stranger's node never heard the line, never fetched the twin, and would not
        // have the key if it had.
        const his = await cal(`id/${adaRoot}/docs/${twin}/body`);
        assert.notEqual(his.status, 200, `the stranger's node does not serve the vault's picture: ${his.status}`);
    });
});
