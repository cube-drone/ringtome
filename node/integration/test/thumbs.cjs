/*
    Many thumbnails in one request (Curtis, 2026-11-01: a long list of pictures, scrolled briskly,
    out-asked the browser's six connections to a host at a request per tile). `POST /docs/thumbs`
    answers a list of ids with each one's thumbnail - the same bytes `/thumb` serves, as base64 -
    and names the ones that have none; it is as private as `/thumb`, and bounded.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');

const SAMPLES = path.join(__dirname, '..', '..', '..', 'sample_media');

describe('many thumbnails in one request', function () {
    this.timeout(600000);

    let ada, root, pictures, note;

    const upload = async (name, pad) => {
        const r = await ada(`api/identity/${root}/docs/binary?title=${encodeURIComponent(name)}`, {
            method: 'POST',
            // Different bytes for each: the same bytes uploaded twice are one document.
            body: Buffer.concat([fs.readFileSync(path.join(SAMPLES, name)), Buffer.from(pad)]),
            file: true,
        });
        assert.equal(r.status, 202, `${name} is queued`);
        const id = (await r.json()).doc_id;
        for (let i = 0; i < 300; i++) {
            if ((await ada(`api/identity/${root}/docs/${id}/thumb`)).status === 200) return id;
            await new Promise((res) => setTimeout(res, 400));
        }
        assert.fail(`${name} never had its thumbnail`);
    };
    const thumbs = (who, ids, at = root) =>
        who(`api/identity/${at}/docs/thumbs`, { method: 'POST', body: JSON.stringify({ ids }) });

    before(async () => {
        ada = await makeUserFetch({ prefix: 'thumbsada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        pictures = [
            await upload('ready_or_not_transparent.png', 'one'),
            await upload('ready_or_not_transparent.png', 'two'),
            await upload('its_webp.webp', 'three'),
        ];
        const made = await ada(`api/identity/${root}/docs`, {
            method: 'POST',
            body: JSON.stringify({ title: 'words', body: 'no picture here', format: 'marquee' }),
        });
        note = (await made.json()).doc_id;
    });

    it("answers each picture with /thumb's own bytes, and names the ids that have none", async () => {
        const nobody = 'ffffffffffffffffffffffffffffffff';
        const r = await thumbs(ada, [...pictures, note, nobody]);
        assert.equal(r.status, 200, await r.clone().text());
        const said = await r.json();
        assert.deepEqual(
            said.thumbs.map((t) => t.doc_id),
            pictures,
            'every picture, in the order asked',
        );
        for (const t of said.thumbs) {
            const one = Buffer.from(
                await (await ada(`api/identity/${root}/docs/${t.doc_id}/thumb`)).arrayBuffer(),
            );
            assert.equal(t.type, 'image/avif');
            assert.ok(Buffer.from(t.data, 'base64').equals(one), `${t.doc_id}: the same bytes`);
        }
        assert.deepEqual(said.missing, [note, nobody], 'the words, and the id of nothing');
    });

    it('is bounded, and refuses an id that is no id', async () => {
        const many = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(32, '0'));
        assert.equal((await thumbs(ada, many)).status, 400, 'a hundred and one is too many');
        assert.equal((await thumbs(ada, many.slice(0, 100))).status, 200, 'a hundred is not');
        assert.equal((await thumbs(ada, ['not-hex'])).status, 400);
    });

    it("is as private as /thumb: another account can't read them", async () => {
        const bea = await makeUserFetch({ prefix: 'thumbsbea' });
        await bea('api/identity', { method: 'POST' });
        const r = await thumbs(bea, pictures);
        assert.notEqual(r.status, 200, 'refused');
        const one = await bea(`api/identity/${root}/docs/${pictures[0]}/thumb`);
        assert.equal(r.status, one.status, 'refused as /thumb refuses');
    });
});
