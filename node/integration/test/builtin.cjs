/*
    The app's own pictures (Curtis, 2026-09-29): every PNG under default_media/ is compiled into
    the node and sits in every persona's files, tagged by its folders - nobody's to delete, and
    the build alone decides what exists. Used in a post or as a chat sticker, it is filed as the
    persona's own copy first (builtin.rs `adopt`), so publication and the say bake it like any
    picture of theirs.
*/
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");

const j = (who, p, body, method = "POST") => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const FILE = path.join(__dirname, "..", "..", "..", "default_media", "sticker", "bodies", "body_1.png");

describe("the app's own pictures", function () {
    this.timeout(120000);

    let ada, root, body1;

    before(async () => {
        ada = await makeUserFetch({ prefix: "builtin" });
        root = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        const docs = (await (await ada(`api/identity/${root}/docs`)).json()).docs;
        body1 = docs.find((d) => d.builtin && d.title === "body_1");
    });

    it("a new persona's files hold every one, tagged by its folders", async () => {
        assert.ok(body1, "sticker/bodies/body_1.png is in the list");
        assert.deepEqual(body1.tags, ["sticker", "bodies"]);
        assert.equal(body1.format, "apng", "a picture every picker takes");
        assert.ok(body1.media.width > 0 && body1.media.height > 0);
        const tagged = (await (await ada(`api/identity/${root}/docs/tagged/bodies`)).json()).docs;
        assert.ok(tagged.some((d) => d.doc_id === body1.doc_id), "the folder answers as a tag");
        const detail = await (await ada(`api/identity/${root}/docs/${body1.doc_id}`)).json();
        assert.equal(detail.builtin, true);
    });

    it("its bytes are the file's, at the body and the thumb", async () => {
        for (const door of ["body", "body/body_1.apng", "thumb"]) {
            const r = await ada(`api/identity/${root}/docs/${body1.doc_id}/${door}`);
            assert.equal(r.status, 200, door);
            assert.equal(r.headers.get("content-type"), "image/png", door);
            assert.deepEqual(Buffer.from(await r.arrayBuffer()), fs.readFileSync(FILE), door);
        }
    });

    it("nobody can delete one", async () => {
        const r = await ada(`api/identity/${root}/docs/${body1.doc_id}`, { method: "DELETE" });
        assert.equal(r.status, 400, await r.text());
    });

    it("used in a post, it's copied as the author's and published like any of their pictures", async () => {
        const note = (await (await j(ada, `api/identity/${root}/docs`, {
            title: "a body",
            body: `![body](/api/identity/${root}/docs/${body1.doc_id}/body/body_1.apng)`,
            format: "marquee",
        })).json()).doc_id;
        let post = null;
        for (let i = 0; i < 80 && !post; i++) {
            const r = await ada(`api/identity/${root}/docs/${note}/publish`, { method: "POST" });
            const b = JSON.parse(await r.text());
            assert.ok(!(b.baking || []).some((x) => x.status === "failed"), `the copy failed: ${JSON.stringify(b.baking)}`);
            if (r.status === 200) post = b.post_id;
            else await wait(500);
        }
        assert.ok(post, "the post minted once the copy landed");
        const words = await (await ada(`id/${root}/docs/${post}/body`)).text();
        const twin = words.match(/\]\((\/ringtome\/user\/[^)]+)\)/);
        assert.ok(twin, `the post's picture is a public one of the author's: ${words}`);
        assert.equal((await ada(twin[1].slice(1))).status, 200, "and it is served");
        const rows = (await (await ada(`api/identity/${root}/docs`)).json()).docs.filter((d) => d.doc_id === body1.doc_id);
        assert.equal(rows.length, 1, "the author's copy stands behind the built-in row, never beside it");
        assert.equal(rows[0].builtin, true);
    });

    it("said as a chat sticker, the say waits out the copy and bakes it", async () => {
        const d = await (await j(ada, `api/identity/${root}/docs`, { title: "stickers", body: "a room", format: "marquee" })).json();
        await ada(`api/identity/${root}/docs/${d.doc_id}/buckets/chat`, { method: "PUT" });
        const pub = await j(ada, `api/identity/${root}/docs/${d.doc_id}/publish`, { room: true });
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        const room = JSON.parse(said).post_id;
        const history = async () => (await ada(`api/identity/${root}/rooms/${root}/${room}/messages`)).json();
        assert.equal((await j(ada, `api/identity/${root}/rooms/${root}/${room}/messages`, { words: "sticker this" })).status, 200);
        const line = (await history()).items.find((m) => m.words === "sticker this");
        assert.ok(line, "the line is in the room");
        const stamp = (await (await ada(`api/identity/${root}/docs`)).json()).docs.find((d) => d.builtin && d.title === "whoa");
        assert.ok(stamp, "sticker/whoa.png is in the list");
        const r = await j(ada, `api/identity/${root}/rooms/${root}/${room}/messages`, {
            words: `![sticker](/api/identity/${root}/docs/${stamp.doc_id}/body/sticker.apng)`,
            reacts_to: line.hash,
        });
        assert.equal(r.status, 200, await r.text());
        const stack = (((await history()).items.find((m) => m.hash === line.hash) || {}).reactions || []).find((x) => x.emoji.startsWith("!["));
        assert.ok(stack && /\/ringtome\/user\//.test(stack.emoji), `the sticker is a public picture: ${JSON.stringify(stack)}`);
    });
});
