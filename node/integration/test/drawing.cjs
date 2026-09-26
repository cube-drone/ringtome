/*
    Drawings (DRAWING.md): a document whose body is its strokes, merged stroke-wise by the node.

    Slice 1, the format: a drawing saves and reads back in its canonical form, inlined like text and
    carrying no media facts; two computers drawing apart - two saves on the same parent - read back
    as ONE drawing with both sets of strokes, minus a stroke one of them undid, never a conflict to
    present; the next save, listing every head as a parent, heals the fork. And the index finds a
    drawing by its title, never by what its strokes are made of.

    Slice 3, copies: a duplicate is a new drawing with the same strokes and tags; a copy into a
    notebook is a picture - the page flattens the canvas and uploads it (doc/drawing.js), which this
    stands in for with a real PNG - filed into the notebook the moment it is uploaded, before the
    node has even made it an image, and an image once it has.

    The publish bar, shared with Writer (Curtis, 2026-09-26): its two wishes and a past claimed date
    ride a drawing's publish as they ride a note's, a future date is refused (drawings have no
    schedule), trusted only seals the post AND its picture, and the drawing stamps the version it
    published, so the bar can tell when the drawing has moved on - a stamp that stays private.

    Slice 4, publishing: a drawing publishes as a picture - the node launders what the page flattened
    into an AVIF twin and posts a Marquee post that is that picture, titled as the drawing is; the
    drawing remembers its post as a draft does, publishing again updates that post, and taking it down
    releases the drawing. Only a drawing comes through this door.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
const WebSocket = require("ws");

const { makeUserFetch, makePng } = require("./helpers.cjs");
const { HOST, makeFetch } = require("./fetch.cjs");

const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

// The browser's own writer: what the page saves is exactly what it would save.
let writeBody;
before(async () => {
    ({ writeBody } = await import("../../js/pure/drawing.js"));
});

const stroke = (id, t, color = "#8a4b1f") => ({ id, t, tool: "brush", color, size: 8, points: [100, 100, 5, 5, 5, 0] });
const A = "a000000000000001", B = "b000000000000002", C = "c000000000000003";
const body = (strokes, undone = []) => writeBody({ strokes, undone });

describe("drawings: strokes as a document, merged stroke by stroke", function () {
    this.timeout(60000);

    let ada, root, doc;
    const docs = () => `api/identity/${root}/docs`;
    const get = async () => (await ada(`${docs()}/${doc}`)).json();
    const save = async (b, parents) => {
        const r = await j(ada, `${docs()}/${doc}`, { title: "a horse", body: b, parents, format: "drawing" }, "PUT");
        const text = await r.text();
        assert.equal(r.status, 200, text);
        return JSON.parse(text).version;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: "drawada" });
        root = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        const made = await j(ada, docs(), { title: "a horse", body: body([]), format: "drawing" });
        assert.equal(made.status, 200, await made.clone().text());
        doc = (await made.json()).doc_id;
    });

    it("saves and reads back canonical, inlined like text, with no media facts", async () => {
        const detail = await get();
        assert.equal(detail.format, "drawing");
        assert.equal(detail.media, null, "strokes are not media");
        assert.equal(detail.resolution, "single");
        assert.equal(detail.body, body([]), "the body rides inline, as written");
    });

    it("two computers drawing apart read back as one drawing - both sets of strokes, minus the undone", async () => {
        const base = await save(body([stroke(A, 1)]), (await get()).save_parents);
        // Two saves on the same parent: two computers, each unaware of the other.
        await save(body([stroke(A, 1), stroke(B, 5)]), [base]);
        await save(body([stroke(C, 3)], [A]), [base]); // this one also undid A

        const detail = await get();
        assert.equal(detail.diverged, true, "the history forked");
        assert.equal(detail.resolution, "merged", "and reads back merged, never as a conflict");
        assert.equal(detail.body, body([stroke(C, 3), stroke(B, 5)], [A]), "B and C, in the order drawn; A stays undone");
        assert.equal(detail.save_parents.length, 2);

        // The editor saves what it opened, listing every head: the fork heals.
        await save(detail.body, detail.save_parents);
        const healed = await get();
        assert.equal(healed.diverged, false);
        assert.equal(healed.resolution, "single");
        assert.equal(healed.body, detail.body);
    });

    it("the list and the index know it by its title, not by its strokes", async () => {
        const cookie = await ada.jar.getCookieString(`http://${HOST}/`);
        const ws = new WebSocket(`ws://${HOST}/api/identity/${root}/stream`, { headers: { Cookie: cookie } });
        const snapshot = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no snapshot")), 10000);
            ws.on("message", (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.docs) {
                    clearTimeout(timer);
                    resolve(msg);
                }
            });
            ws.on("error", reject);
        });
        ws.close();
        const row = snapshot.docs.find((d) => d.doc_id === doc);
        assert.ok(row, "listed");
        assert.equal(row.format, "drawing");
        assert.equal(row.media, null, "so no list files it under media");
        const index = (snapshot.search || []).find((s) => s.doc_id === doc);
        assert.ok(index, "indexed");
        assert.ok(index.tokens.includes("horse"), `found by its title: ${index.tokens}`);
        for (const not of ["brush", "a000000000000001", "8a4b1f", "strokes"]) {
            assert.ok(!index.tokens.includes(not), `never by its strokes: ${not}`);
        }
    });

    it("a duplicate is a new drawing with the same strokes and tags", async () => {
        await ada(`${docs()}/${doc}/annotations/tags/horses`, { method: "PUT" });
        const original = await get();
        const made = await j(ada, `${docs()}/copy`, { author: root, doc_id: doc, bucket: "drawing", new: false, private: true });
        const madeText = await made.text();
        assert.equal(made.status, 200, madeText);
        const copy = JSON.parse(madeText).doc_id;
        assert.notEqual(copy, doc);
        const detail = await (await ada(`${docs()}/${copy}`)).json();
        assert.equal(detail.format, "drawing");
        assert.equal(detail.body, original.body, "every stroke");
        const tags = await (await ada(`${docs()}/${copy}/annotations`)).json();
        assert.ok(JSON.stringify(tags).includes("horses"), `and the tags: ${JSON.stringify(tags)}`);
    });

    it("a copy into a notebook is a picture, filed the moment it is uploaded", async () => {
        const up = await ada(`${docs()}/binary?title=a%20horse`, { method: "POST", body: makePng(40, 30), file: true });
        assert.equal(up.status, 202);
        const { doc_id: picture, job_id } = await up.json();
        const filed = await ada(`${docs()}/${picture}/buckets/stable`, { method: "PUT" });
        assert.ok(filed.ok, `filed before the ingest finished: ${filed.status}`);
        for (let i = 0; i < 200; i++) {
            const job = (await (await ada(`api/identity/${root}/ingest`)).json()).find((x) => x.job_id === job_id);
            if (job && job.status === "done") break;
            if (job && job.status === "failed") assert.fail(job.error);
            await new Promise((r) => setTimeout(r, 150));
        }
        const row = (await (await ada(docs())).json()).docs.find((d) => d.doc_id === picture);
        assert.ok(row, "listed");
        assert.equal(row.format, "avif", "a picture, not a drawing");
        assert.ok(row.buckets.includes("stable"), `in the notebook: ${JSON.stringify(row.buckets)}`);
    });

    it("publishes as a picture, remembers its post, updates it, and comes down", async () => {
        await j(ada, `${docs()}/${doc}/title`, { title: "a horse, running" }, "PATCH");
        const publish = async () => {
            const r = await ada(`${docs()}/${doc}/publish/drawing`, { method: "POST", body: makePng(80, 60), file: true });
            const text = await r.text();
            assert.equal(r.status, 200, text);
            return JSON.parse(text).post_id;
        };
        const post = await publish();
        const anon = makeFetch();
        const words = await (await anon(`id/${root}/docs/${post}/body`)).text();
        const embed = /^!\[a horse, running\]\((\/id\/[0-9a-f]+\/docs\/[0-9a-f]+\/body\/media\.avif)\)$/m.exec(words);
        assert.ok(embed, `the post is the picture, titled as the drawing: ${words}`);
        const picture = await anon(embed[1].slice(1));
        assert.equal(picture.status, 200, "and the picture serves to anyone");
        assert.equal(picture.headers.get("content-type"), "image/avif", "laundered into the node's own format");

        const fields = async () => (await (await ada(`${docs()}/${doc}/annotations`)).json()).fields || {};
        assert.equal((await fields()).published_as, post, "the drawing remembers its post");
        assert.equal(await publish(), post, "publishing again updates the same post");

        const down = await ada(`api/identity/${root}/posts/${post}`, { method: "DELETE" });
        assert.ok(down.ok, `taken down: ${down.status}`);
        assert.notEqual((await anon(`id/${root}/docs/${post}/body`)).status, 200, "gone from the public");
        assert.ok(!(await fields()).published_as, "and the drawing is a draft again");
    });

    it("only a drawing comes through the drawing door", async () => {
        const note = await (await j(ada, docs(), { title: "words", body: "just words", format: "marquee" })).json();
        const r = await ada(`${docs()}/${note.doc_id}/publish/drawing`, { method: "POST", body: makePng(8, 8), file: true });
        assert.equal(r.status, 400);
        const plain = await ada(`${docs()}/${doc}/publish`, { method: "POST" });
        assert.equal(plain.status, 400, "and a drawing never posts through the words door as strokes");
    });

    it("wears the publish bar's wishes and date, and knows when it has changed since", async () => {
        const made = await (await j(ada, docs(), { title: "an old horse", body: body([stroke(A, 1)]), format: "drawing" })).json();
        const id = made.doc_id;
        const field = (name, value) => j(ada, `${docs()}/${id}/annotations/fields/${name}`, { value }, "PUT");
        const row = async () => (await (await ada(docs())).json()).docs.find((d) => d.doc_id === id);
        const publish = async (query = "") => ada(`${docs()}/${id}/publish/drawing?tz_offset_min=0${query}`, { method: "POST", body: makePng(40, 30), file: true });

        await field("display_date", "2099-01-01");
        const future = await publish();
        assert.equal(future.status, 400, "a drawing has no schedule");
        assert.match(await future.text(), /scheduled/);

        await field("display_date", "2020-05-01");
        const first = await publish("&settled=true");
        const firstText = await first.text();
        assert.equal(first.status, 200, firstText);
        const { post_id, dated_ms } = JSON.parse(firstText);
        assert.ok(dated_ms && dated_ms < Date.UTC(2020, 5, 1), `the claimed date dates the post: ${dated_ms}`);
        const permalink = async () => (await ada(`api/id/${root}/posts/${post_id}`)).json();
        assert.equal((await permalink()).settled, true, "comments off, as asked");

        let r = await row();
        assert.equal(r.fields.published_head, r.head, "the drawing stamps the version it published");

        const detail = await (await ada(`${docs()}/${id}`)).json();
        await j(ada, `${docs()}/${id}`, { title: "an old horse", body: body([stroke(A, 1), stroke(B, 2)]), parents: detail.save_parents, format: "drawing" }, "PUT");
        r = await row();
        assert.notEqual(r.head, r.fields.published_head, "a stroke since moves it past what was published");

        const again = await publish();
        assert.equal(again.status, 200, await again.text());
        r = await row();
        assert.equal(r.fields.published_head, r.head, "an update stamps the new version");
        const labels = ((await permalink()).annotations || []).map((a) => a.key);
        assert.ok(!labels.includes("published_head") && !labels.includes("published_as"), `the stamp stays private: ${labels}`);
    });

    it("trusted only seals the post, and its picture with it", async () => {
        const made = await (await j(ada, docs(), { title: "a secret horse", body: body([stroke(C, 1)]), format: "drawing" })).json();
        const r = await ada(`${docs()}/${made.doc_id}/publish/drawing?trusted_only=true`, { method: "POST", body: makePng(40, 30), file: true });
        const text = await r.text();
        assert.equal(r.status, 200, text);
        const post = JSON.parse(text).post_id;
        const words = await (await ada(`id/${root}/docs/${post}/body`)).text();
        const target = /\((\/id\/[^)]+)\)/.exec(words);
        assert.ok(target, `the author reads their own post: ${words}`);
        const anon = makeFetch();
        assert.notEqual((await anon(`id/${root}/docs/${post}/body`)).status, 200, "a stranger cannot read the post");
        assert.notEqual((await anon(target[1].slice(1))).status, 200, "nor fetch its picture");
    });
});
