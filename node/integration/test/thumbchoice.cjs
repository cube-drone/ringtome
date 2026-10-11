/*
    A media document's thumbnail, chosen (Curtis, 2026-10-11: a cover picked beside a sound's
    fields): a picture lends its own thumbnail, a picture's bytes are crushed to one, and the
    thumbnail it was made with comes back on request. Each is a version that changes nothing else;
    text has no thumbnail to choose.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');

const SAMPLES = path.join(__dirname, '..', '..', '..', 'sample_media');

describe("a media document's thumbnail is chosen", function () {
    this.timeout(600000);

    let ada, root, sound, picture, born;

    const upload = async (name) => {
        const r = await ada(`api/identity/${root}/docs/binary?title=${encodeURIComponent(name)}`, {
            method: 'POST',
            body: fs.readFileSync(path.join(SAMPLES, name)),
            file: true,
        });
        assert.equal(r.status, 202, `${name} is queued`);
        const id = (await r.json()).doc_id;
        for (let i = 0; i < 300; i++) {
            if ((await ada(`api/identity/${root}/docs/${id}/body`)).status === 200) return id;
            await new Promise((res) => setTimeout(res, 400));
        }
        assert.fail(`${name} was never made`);
    };
    const thumb = async (id) => {
        const r = await ada(`api/identity/${root}/docs/${id}/thumb`);
        assert.equal(r.status, 200, `${id} has a thumbnail`);
        return Buffer.from(await r.arrayBuffer());
    };
    const title = async (id) => (await (await ada(`api/identity/${root}/docs/${id}`)).json()).title;

    before(async () => {
        ada = await makeUserFetch({ prefix: 'thumbada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        sound = await upload('buck-cover.mp3');
        picture = await upload('floppy.png');
        born = await thumb(sound);
    });

    it('a picture lends the sound its own thumbnail, and the sound is otherwise as it was', async () => {
        const r = await ada(`api/identity/${root}/docs/${sound}/thumb`, {
            method: 'PUT',
            body: JSON.stringify({ from_doc: picture }),
        });
        assert.equal(r.status, 200, await r.clone().text());
        assert.ok((await thumb(sound)).equals(await thumb(picture)), "the picture's thumbnail");
        assert.equal(await title(sound), 'buck-cover.mp3', 'the title stands');
        assert.equal(
            (await ada(`api/identity/${root}/docs/${sound}/body`)).status,
            200,
            'and so does the sound',
        );
    });

    it('back to its own is the cover it was made with', async () => {
        const r = await ada(`api/identity/${root}/docs/${sound}/thumb`, { method: 'DELETE' });
        assert.equal(r.status, 200);
        assert.ok((await thumb(sound)).equals(born));
    });

    it("a picture's bytes are crushed to a thumbnail", async () => {
        const r = await ada(`api/identity/${root}/docs/${sound}/thumb`, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/png' },
            file: true,
            body: fs.readFileSync(path.join(SAMPLES, 'ready_or_not_transparent.png')),
        });
        assert.equal(r.status, 200, await r.clone().text());
        const now = await thumb(sound);
        assert.ok(!now.equals(born), 'a new thumbnail');
        assert.equal(now.subarray(4, 8).toString(), 'ftyp', 'an AVIF one');
    });

    it('a text document has no thumbnail to choose, and bytes that are no picture are refused', async () => {
        const note = await (
            await ada(`api/identity/${root}/docs`, {
                method: 'POST',
                body: JSON.stringify({ title: 'words', body: 'words', format: 'marquee' }),
            })
        ).json();
        const text = await ada(`api/identity/${root}/docs/${note.doc_id}/thumb`, {
            method: 'PUT',
            body: JSON.stringify({ from_doc: picture }),
        });
        assert.equal(text.status, 400);
        const junk = await ada(`api/identity/${root}/docs/${sound}/thumb`, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/png' },
            file: true,
            body: Buffer.from('not a picture at all'),
        });
        assert.equal(junk.status, 400);
    });
});
