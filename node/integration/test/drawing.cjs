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
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const WebSocket = require('ws');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { HOST, makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

// The browser's own writer: what the page saves is exactly what it would save.
let writeBody, model;
before(async () => {
    model = await import('../../js/pure/drawing.js');
    ({ writeBody } = model);
});

const stroke = (id, t, color = '#8a4b1f') => ({
    id,
    t,
    tool: 'brush',
    color,
    size: 8,
    points: [100, 100, 5, 5, 5, 0],
});
const A = 'a000000000000001',
    B = 'b000000000000002',
    C = 'c000000000000003';
const body = (strokes, undone = []) => writeBody({ strokes, undone });

describe('drawings: strokes as a document, merged stroke by stroke', function () {
    this.timeout(60000);

    let ada, root, doc;
    const docs = () => `api/identity/${root}/docs`;
    const get = async () => (await ada(`${docs()}/${doc}`)).json();
    const save = async (b, parents) => {
        const r = await j(
            ada,
            `${docs()}/${doc}`,
            { title: 'a horse', body: b, parents, format: 'drawing' },
            'PUT',
        );
        const text = await r.text();
        assert.equal(r.status, 200, text);
        return JSON.parse(text).version;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'drawada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        const made = await j(ada, docs(), { title: 'a horse', body: body([]), format: 'drawing' });
        assert.equal(made.status, 200, await made.clone().text());
        doc = (await made.json()).doc_id;
    });

    it('saves and reads back canonical, inlined like text, with no media facts', async () => {
        const detail = await get();
        assert.equal(detail.format, 'drawing');
        assert.equal(detail.media, null, 'strokes are not media');
        assert.equal(detail.resolution, 'single');
        assert.equal(detail.body, body([]), 'the body rides inline, as written');
    });

    it('two computers drawing apart read back as one drawing - both sets of strokes, minus the undone', async () => {
        const base = await save(body([stroke(A, 1)]), (await get()).save_parents);
        // Two saves on the same parent: two computers, each unaware of the other.
        await save(body([stroke(A, 1), stroke(B, 5)]), [base]);
        await save(body([stroke(C, 3)], [A]), [base]); // this one also undid A

        const detail = await get();
        assert.equal(detail.diverged, true, 'the history forked');
        assert.equal(detail.resolution, 'merged', 'and reads back merged, never as a conflict');
        assert.equal(
            detail.body,
            body([stroke(C, 3), stroke(B, 5)], [A]),
            'B and C, in the order drawn; A stays undone',
        );
        assert.equal(detail.save_parents.length, 2);

        // The editor saves what it opened, listing every head: the fork heals.
        await save(detail.body, detail.save_parents);
        const healed = await get();
        assert.equal(healed.diverged, false);
        assert.equal(healed.resolution, 'single');
        assert.equal(healed.body, detail.body);
    });

    it('the list and the index know it by its title, not by its strokes', async () => {
        const cookie = await ada.jar.getCookieString(`http://${HOST}/`);
        const ws = new WebSocket(`ws://${HOST}/api/identity/${root}/stream`, {
            headers: { Cookie: cookie },
        });
        const snapshot = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no snapshot')), 10000);
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.docs) {
                    clearTimeout(timer);
                    resolve(msg);
                }
            });
            ws.on('error', reject);
        });
        ws.close();
        const row = snapshot.docs.find((d) => d.doc_id === doc);
        assert.ok(row, 'listed');
        assert.equal(row.format, 'drawing');
        assert.equal(row.media, null, 'so no list files it under media');
        const index = (snapshot.search || []).find((s) => s.doc_id === doc);
        assert.ok(index, 'indexed');
        assert.ok(index.tokens.includes('horse'), `found by its title: ${index.tokens}`);
        for (const not of ['brush', 'a000000000000001', '8a4b1f', 'strokes']) {
            assert.ok(!index.tokens.includes(not), `never by its strokes: ${not}`);
        }
    });

    it('a duplicate is a new drawing with the same strokes and tags', async () => {
        await ada(`${docs()}/${doc}/annotations/tags/horses`, { method: 'PUT' });
        const original = await get();
        const made = await j(ada, `${docs()}/copy`, {
            author: root,
            doc_id: doc,
            bucket: 'drawing',
            new: false,
            private: true,
        });
        const madeText = await made.text();
        assert.equal(made.status, 200, madeText);
        const copy = JSON.parse(madeText).doc_id;
        assert.notEqual(copy, doc);
        const detail = await (await ada(`${docs()}/${copy}`)).json();
        assert.equal(detail.format, 'drawing');
        assert.equal(detail.body, original.body, 'every stroke');
        const tags = await (await ada(`${docs()}/${copy}/annotations`)).json();
        assert.ok(JSON.stringify(tags).includes('horses'), `and the tags: ${JSON.stringify(tags)}`);
    });

    it('a copy into a notebook is a picture, filed the moment it is uploaded', async () => {
        const up = await ada(`${docs()}/binary?title=a%20horse`, {
            method: 'POST',
            body: makePng(40, 30),
            file: true,
        });
        assert.equal(up.status, 202);
        const { doc_id: picture, job_id } = await up.json();
        const filed = await ada(`${docs()}/${picture}/buckets/stable`, { method: 'PUT' });
        assert.ok(filed.ok, `filed before the ingest finished: ${filed.status}`);
        for (let i = 0; i < 200; i++) {
            const job = (await (await ada(`api/identity/${root}/ingest`)).json()).find(
                (x) => x.job_id === job_id,
            );
            if (job && job.status === 'done') break;
            if (job && job.status === 'failed') assert.fail(job.error);
            await new Promise((r) => setTimeout(r, 150));
        }
        const row = (await (await ada(docs())).json()).docs.find((d) => d.doc_id === picture);
        assert.ok(row, 'listed');
        assert.equal(row.format, 'avif', 'a picture, not a drawing');
        assert.ok(
            row.buckets.includes('stable'),
            `in the notebook: ${JSON.stringify(row.buckets)}`,
        );
    });

    it('publishes as a picture, remembers its post, updates it, and comes down', async () => {
        await j(ada, `${docs()}/${doc}/title`, { title: 'a horse, running' }, 'PATCH');
        const publish = async () => {
            const r = await ada(`${docs()}/${doc}/publish/drawing`, {
                method: 'POST',
                body: makePng(80, 60),
                file: true,
            });
            const text = await r.text();
            assert.equal(r.status, 200, text);
            return JSON.parse(text).post_id;
        };
        const post = await publish();
        const anon = makeFetch();
        const words = await (await anon(`id/${root}/docs/${post}/body`)).text();
        const embed =
            /^!\[a horse, running\]\((\/ringtome\/user\/[A-Za-z0-9]+\/doc\/[0-9a-f]+\/body\/media\.avif)\)$/m.exec(
                words,
            );
        assert.ok(embed, `the post is the picture, titled as the drawing: ${words}`);
        const picture = await anon(embed[1].slice(1));
        assert.equal(picture.status, 200, 'and the picture serves to anyone');
        assert.equal(
            picture.headers.get('content-type'),
            'image/avif',
            "laundered into the node's own format",
        );

        const fields = async () =>
            (await (await ada(`${docs()}/${doc}/annotations`)).json()).fields || {};
        assert.equal((await fields()).published_as, post, 'the drawing remembers its post');
        assert.equal(await publish(), post, 'publishing again updates the same post');

        const down = await ada(`api/identity/${root}/posts/${post}`, { method: 'DELETE' });
        assert.ok(down.ok, `taken down: ${down.status}`);
        assert.notEqual(
            (await anon(`id/${root}/docs/${post}/body`)).status,
            200,
            'gone from the public',
        );
        assert.ok(!(await fields()).published_as, 'and the drawing is a draft again');
    });

    it('only a drawing comes through the drawing door', async () => {
        const note = await (
            await j(ada, docs(), { title: 'words', body: 'just words', format: 'marquee' })
        ).json();
        const r = await ada(`${docs()}/${note.doc_id}/publish/drawing`, {
            method: 'POST',
            body: makePng(8, 8),
            file: true,
        });
        assert.equal(r.status, 400);
        const plain = await ada(`${docs()}/${doc}/publish`, { method: 'POST' });
        assert.equal(
            plain.status,
            400,
            'and a drawing never posts through the words door as strokes',
        );
    });

    it("wears the publish bar's wishes and date, and knows when it has changed since", async () => {
        const made = await (
            await j(ada, docs(), {
                title: 'an old horse',
                body: body([stroke(A, 1)]),
                format: 'drawing',
            })
        ).json();
        const id = made.doc_id;
        const field = (name, value) =>
            j(ada, `${docs()}/${id}/annotations/fields/${name}`, { value }, 'PUT');
        const row = async () =>
            (await (await ada(docs())).json()).docs.find((d) => d.doc_id === id);
        const publish = async (query = '') =>
            ada(`${docs()}/${id}/publish/drawing?tz_offset_min=0${query}`, {
                method: 'POST',
                body: makePng(40, 30),
                file: true,
            });

        await field('display_date', '2099-01-01');
        const future = await publish();
        assert.equal(future.status, 400, 'a drawing has no schedule');
        assert.match(await future.text(), /scheduled/);

        await field('display_date', '2020-05-01');
        const first = await publish('&settled=true');
        const firstText = await first.text();
        assert.equal(first.status, 200, firstText);
        const { post_id, dated_ms } = JSON.parse(firstText);
        assert.ok(
            dated_ms && dated_ms < Date.UTC(2020, 5, 1),
            `the claimed date dates the post: ${dated_ms}`,
        );
        const permalink = async () => (await ada(`api/id/${root}/posts/${post_id}`)).json();
        assert.equal((await permalink()).settled, true, 'comments off, as asked');

        let r = await row();
        assert.equal(
            r.fields.published_head,
            r.head,
            'the drawing stamps the version it published',
        );

        const detail = await (await ada(`${docs()}/${id}`)).json();
        await j(
            ada,
            `${docs()}/${id}`,
            {
                title: 'an old horse',
                body: body([stroke(A, 1), stroke(B, 2)]),
                parents: detail.save_parents,
                format: 'drawing',
            },
            'PUT',
        );
        r = await row();
        assert.notEqual(
            r.head,
            r.fields.published_head,
            'a stroke since moves it past what was published',
        );

        const again = await publish();
        assert.equal(again.status, 200, await again.text());
        r = await row();
        assert.equal(r.fields.published_head, r.head, 'an update stamps the new version');
        const labels = ((await permalink()).annotations || []).map((a) => a.key);
        assert.ok(
            !labels.includes('published_head') && !labels.includes('published_as'),
            `the stamp stays private: ${labels}`,
        );
    });

    it('trusted only seals the post, and its picture with it', async () => {
        const made = await (
            await j(ada, docs(), {
                title: 'a secret horse',
                body: body([stroke(C, 1)]),
                format: 'drawing',
            })
        ).json();
        const r = await ada(`${docs()}/${made.doc_id}/publish/drawing?trusted_only=true`, {
            method: 'POST',
            body: makePng(40, 30),
            file: true,
        });
        const text = await r.text();
        assert.equal(r.status, 200, text);
        const post = JSON.parse(text).post_id;
        const words = await (await ada(`id/${root}/docs/${post}/body`)).text();
        const target = /\((\/ringtome\/user\/[^)]+)\)/.exec(words);
        assert.ok(target, `the author reads their own post: ${words}`);
        const anon = makeFetch();
        assert.notEqual(
            (await anon(`id/${root}/docs/${post}/body`)).status,
            200,
            'a stranger cannot read the post',
        );
        assert.notEqual((await anon(target[1].slice(1))).status, 200, 'nor fetch its picture');
    });

    it("keeps a pen stroke's pressure through a save and a merge", async () => {
        const pen = { ...stroke('d000000000000004', 9), pressure: [15, 60, 100] };
        const made = await (
            await j(ada, docs(), { title: 'a pressed horse', body: body([pen]), format: 'drawing' })
        ).json();
        const read = async () => (await ada(`${docs()}/${made.doc_id}`)).json();
        assert.equal((await read()).body, body([pen]), 'saved and read back with its pressure');
        // Fork it: the merge keeps each stroke's pressure as it was.
        const parents = (await read()).save_parents;
        const other = stroke('e000000000000005', 10);
        await j(
            ada,
            `${docs()}/${made.doc_id}`,
            { title: 'a pressed horse', body: body([pen, other]), parents, format: 'drawing' },
            'PUT',
        );
        const third = { ...stroke('f000000000000006', 11), pressure: [100, 50, 5] };
        await j(
            ada,
            `${docs()}/${made.doc_id}`,
            { title: 'a pressed horse', body: body([pen, third]), parents, format: 'drawing' },
            'PUT',
        );
        const merged = await read();
        assert.equal(merged.resolution, 'merged', 'a real fork, merged');
        assert.equal(
            merged.body,
            body([pen, other, third]),
            "every stroke's pressure intact through the merge",
        );
    });

    it("merges layers across a fork exactly as the page's own model does", async () => {
        const L2 = 'aaaaaaaaaaaaaaa2';
        let start = model.addLayer(model.readBody(body([])), L2, 10);
        const made = await (
            await j(ada, docs(), {
                title: 'a layered horse',
                body: writeBody(start),
                format: 'drawing',
            })
        ).json();
        const read = async () => (await ada(`${docs()}/${made.doc_id}`)).json();
        const parents = (await read()).save_parents;
        // Here: hide the layer, and draw on it. There: fade it (earlier), and draw on the base.
        const here = model.addStroke(model.setLayer(start, L2, { hidden: true }, 20), {
            ...stroke('a100000000000001', 30),
            layer: L2,
        });
        const there = model.addStroke(
            model.setLayer(start, L2, { opacity: 25 }, 15),
            stroke('b100000000000002', 31),
        );
        for (const side of [here, there]) {
            await j(
                ada,
                `${docs()}/${made.doc_id}`,
                { title: 'a layered horse', body: writeBody(side), parents, format: 'drawing' },
                'PUT',
            );
        }
        const merged = await read();
        assert.equal(merged.resolution, 'merged');
        assert.equal(
            merged.body,
            writeBody(model.mergeBodies(here, there)),
            "the node's merge is the page's, byte for byte",
        );
        const l2 = model.layersOf(model.readBody(merged.body)).find((l) => l.id === L2);
        assert.deepEqual([l2.hidden, l2.opacity], [true, 100], 'the later change to the layer won');
        assert.equal(
            model.strokesOn(model.readBody(merged.body), L2).length,
            1,
            'and each stroke kept its layer',
        );
    });

    it('two computers grabbing one layer at once: both moves stand, and an undo takes one back', async () => {
        const start = model.readBody(body([stroke('a200000000000001', 1)]));
        const made = await (
            await j(ada, docs(), {
                title: 'a moving horse',
                body: writeBody(start),
                format: 'drawing',
            })
        ).json();
        const read = async () => (await ada(`${docs()}/${made.doc_id}`)).json();
        const parents = (await read()).save_parents;
        const here = model.addStroke(start, {
            id: 'b200000000000002',
            t: 5,
            tool: 'move',
            dx: 10,
            dy: 0,
        });
        const there = model.addStroke(start, {
            id: 'c200000000000003',
            t: 6,
            tool: 'move',
            dx: 0,
            dy: -20,
        });
        for (const side of [here, there]) {
            await j(
                ada,
                `${docs()}/${made.doc_id}`,
                { title: 'a moving horse', body: writeBody(side), parents, format: 'drawing' },
                'PUT',
            );
        }
        const merged = await read();
        assert.equal(
            merged.body,
            writeBody(model.mergeBodies(here, there)),
            "the node's merge is the page's",
        );
        const drawing = model.readBody(merged.body);
        assert.deepEqual(
            model.offsetsOf(model.strokesOn(drawing, model.BASE_LAYER)).total,
            [10, -20],
            'both grabs stand',
        );
        const undone = model.undo(drawing);
        assert.deepEqual(
            model.offsetsOf(model.strokesOn(undone, model.BASE_LAYER)).total,
            [10, 0],
            'and undo takes the newest back',
        );
    });

    it('a layer duplicated here and thrown away there merges as the page merges it', async () => {
        const L2 = 'aaaaaaaaaaaaaaa2',
            L3 = 'aaaaaaaaaaaaaaa3';
        let start = model.addLayer(model.readBody(body([])), L2, 1);
        start = model.addStroke(start, { ...stroke('a300000000000001', 2), layer: L2 });
        const made = await (
            await j(ada, docs(), {
                title: 'a copied horse',
                body: writeBody(start),
                format: 'drawing',
            })
        ).json();
        const read = async () => (await ada(`${docs()}/${made.doc_id}`)).json();
        const parents = (await read()).save_parents;
        const here = model.duplicateLayer(start, L2, L3, 'b300000000000002', 10);
        const there = model.deleteLayer(start, L2, 'c300000000000003', 11);
        for (const side of [here, there]) {
            await j(
                ada,
                `${docs()}/${made.doc_id}`,
                { title: 'a copied horse', body: writeBody(side), parents, format: 'drawing' },
                'PUT',
            );
        }
        const merged = await read();
        assert.equal(
            merged.body,
            writeBody(model.mergeBodies(here, there)),
            "the node's merge is the page's",
        );
        const drawing = model.readBody(merged.body);
        assert.deepEqual(
            model.layersOf(drawing).map((l) => l.id),
            [model.BASE_LAYER, L3],
            'the source is gone; its copy stays',
        );
        assert.deepEqual(
            model.effectiveOps(drawing, L3).map((o) => o.id),
            ['a300000000000001'],
            'holding what the source held',
        );
    });

    it('two computers naming one layer at once agree with the page, and a name it cannot keep is dropped', async () => {
        const L2 = 'aaaaaaaaaaaaaaa2';
        const start = model.addLayer(model.readBody(body([])), L2, 1);
        const made = await (
            await j(ada, docs(), {
                title: 'a named horse',
                body: writeBody(start),
                format: 'drawing',
            })
        ).json();
        const read = async () => (await ada(`${docs()}/${made.doc_id}`)).json();
        const parents = (await read()).save_parents;
        // The same instant, so the tie breaks on the name - where JavaScript's own string order and
        // UTF-8's part ways.
        const here = model.setLayer(start, L2, { name: '\uFF5E' }, 9);
        const there = model.setLayer(start, L2, { name: '🐴 the mane' }, 9);
        for (const side of [here, there]) {
            await j(
                ada,
                `${docs()}/${made.doc_id}`,
                { title: 'a named horse', body: writeBody(side), parents, format: 'drawing' },
                'PUT',
            );
        }
        const merged = await read();
        assert.equal(
            merged.body,
            writeBody(model.mergeBodies(here, there)),
            "the node's merge is the page's",
        );
        assert.equal(model.layersOf(model.readBody(merged.body))[1].name, '🐴 the mane');

        // A body written by hand, not by the page: the node keeps the layer and drops the name.
        const raw = JSON.parse(writeBody(start));
        raw.layers[0].name = 'tab\there';
        await j(
            ada,
            `${docs()}/${made.doc_id}`,
            {
                title: 'a named horse',
                body: JSON.stringify(raw),
                parents: merged.save_parents,
                format: 'drawing',
            },
            'PUT',
        );
        const kept = model.layersOf(model.readBody((await read()).body));
        assert.deepEqual([kept[1].id, 'name' in kept[1]], [L2, false]);
    });

    it('pours from two computers both stand after a merge, kept exactly as the page wrote them', async () => {
        const start = model.readBody(body([stroke('a500000000000001', 1)]));
        const made = await (
            await j(ada, docs(), {
                title: 'a poured horse',
                body: writeBody(start),
                format: 'drawing',
            })
        ).json();
        const read = async () => (await ada(`${docs()}/${made.doc_id}`)).json();
        const parents = (await read()).save_parents;
        const here = model.addStroke(start, {
            id: 'b500000000000002',
            t: 5,
            tool: 'bucket',
            color: '#1f9e90',
            points: [30, 40],
            reach: 250,
        });
        const there = model.addStroke(start, {
            id: 'c500000000000003',
            t: 6,
            tool: 'bucket',
            color: '#8a4b1f',
            points: [700, 500],
            reach: 12,
        });
        for (const side of [here, there]) {
            await j(
                ada,
                `${docs()}/${made.doc_id}`,
                { title: 'a poured horse', body: writeBody(side), parents, format: 'drawing' },
                'PUT',
            );
        }
        const merged = await read();
        assert.equal(
            merged.body,
            writeBody(model.mergeBodies(here, there)),
            "the node's merge is the page's, byte for byte",
        );
        const pours = model.readBody(merged.body).strokes.filter((s) => s.tool === 'bucket');
        assert.deepEqual(
            pours.map((s) => [s.points, s.reach]),
            [
                [[30, 40], 250],
                [[700, 500], 12],
            ],
        );
    });

    it("an image added from the person's media is kept by reference, and its pixels are there to paint", async () => {
        // A picture, through the ordinary upload door, crushed as any picture is.
        const up = await ada(`${docs()}/binary?title=a%20grey%20horse`, {
            method: 'POST',
            body: makePng(64, 48),
            file: true,
        });
        assert.equal(up.status, 202);
        const { doc_id: picture, job_id } = await up.json();
        for (let i = 0; i < 200; i++) {
            const job = (await (await ada(`api/identity/${root}/ingest`)).json()).find(
                (x) => x.job_id === job_id,
            );
            if (job && job.status === 'done') break;
            if (job && job.status === 'failed') assert.fail(job.error);
            await new Promise((r) => setTimeout(r, 150));
        }
        const row = (await (await ada(docs())).json()).docs.find((d) => d.doc_id === picture);
        assert.deepEqual(
            [row.media.width, row.media.height],
            [64, 48],
            'the size the picker places it by',
        );

        // The page adds it exactly as the drawing surface does, and saves.
        const L = 'aaaaaaaaaaaaaaa9';
        const drawn = model.addImage(
            model.readBody(body([stroke('a600000000000001', 1)])),
            { doc: picture, width: 64, height: 48, title: row.title },
            L,
            'f600000000000002',
            5,
        );
        const made = await (
            await j(ada, docs(), {
                title: 'a horse from life',
                body: writeBody(drawn),
                format: 'drawing',
            })
        ).json();
        const back = await (await ada(`${docs()}/${made.doc_id}`)).json();
        assert.equal(back.body, writeBody(drawn), 'the node keeps the image entry, byte for byte');
        const entry = model.readBody(back.body).strokes.find((s) => s.tool === 'image');
        assert.deepEqual(
            [entry.doc, entry.points, entry.w, entry.h],
            [picture, [368, 276], 64, 48],
        );
        assert.equal(
            model.layersOf(model.readBody(back.body)).at(-1).name,
            'a grey horse',
            'on its own layer, named for it',
        );

        // What the page fetches to paint it: the picture's own body.
        const pixels = await ada(`${docs()}/${picture}/body`);
        assert.equal(pixels.status, 200);
        assert.match(pixels.headers.get('content-type') || '', /^image\//);
    });

    it("a drawing's flat copy carries what it is a copy of, where the next pick will look for it", async () => {
        // drawingAsPicture (doc/drawing.js) cuts a drawing into a picture once per version, and
        // finds it again by two private annotations on the picture's row (pure/flatcopy.js) - so
        // those must ride the documents list the mirror is fed from.
        const up = await ada(`${docs()}/binary?title=a%20flat%20horse`, {
            method: 'POST',
            body: makePng(16, 12),
            file: true,
        });
        assert.equal(up.status, 202);
        const { doc_id: copy, job_id } = await up.json();
        const note = async (field, value) => {
            const r = await ada(`${docs()}/${copy}/annotations/fields/${field}`, {
                method: 'PUT',
                body: JSON.stringify({ value }),
            });
            assert.equal(r.status, 200, await r.text());
        };
        await note('flattened_from', doc);
        await note('flattened_version', 'a1,b2');
        // Noted before the picture is even processed, as the page does; its row lists once it is.
        for (let i = 0; i < 200; i++) {
            const job = (await (await ada(`api/identity/${root}/ingest`)).json()).find(
                (x) => x.job_id === job_id,
            );
            if (job && job.status === 'done') break;
            if (job && job.status === 'failed') assert.fail(job.error);
            await new Promise((r) => setTimeout(r, 150));
        }
        const row = (await (await ada(docs())).json()).docs.find((d) => d.doc_id === copy);
        assert.ok(row, 'the copy is listed once processed');
        assert.deepEqual([row.fields.flattened_from, row.fields.flattened_version], [doc, 'a1,b2']);
    });
});
