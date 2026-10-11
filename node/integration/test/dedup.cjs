/*
    Private dedup (plans/DEDUP.md, 2026-10-11): a persona uploading a file it already has gets the
    document it made of those bytes before - same id, the title it already had - and no copy; once
    that document is deleted, the same bytes make a new one; and another persona's upload of the
    same bytes is its own, since dedup never crosses personas.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');

const SAMPLES = path.join(__dirname, '..', '..', '..', 'sample_media');
const FLOPPY = path.join(SAMPLES, 'floppy.png');

describe('private dedup: the same upload is the same document', function () {
    this.timeout(600000);

    let ada, adaRoot, first;
    const picture = fs.readFileSync(FLOPPY);

    const upload = (who, root, title) =>
        who(`api/identity/${root}/docs/binary?title=${encodeURIComponent(title)}`, {
            method: 'POST',
            body: picture,
            file: true,
        });

    /// Wait for ingest to make the document: its body answers once its version exists.
    const made = async (who, root, docId) => {
        for (let i = 0; i < 300; i++) {
            const r = await who(`api/identity/${root}/docs/${docId}/body`);
            if (r.status === 200) return;
            await new Promise((res) => setTimeout(res, 400));
        }
        assert.fail(`${docId} was never made`);
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'dupada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
    });

    it('a first upload is queued and made, as ever', async () => {
        const r = await upload(ada, adaRoot, 'floppy');
        assert.equal(r.status, 202);
        first = (await r.json()).doc_id;
        await made(ada, adaRoot, first);
    });

    it('the same bytes again are that document again, under the title it already had', async () => {
        const r = await upload(ada, adaRoot, 'a different name');
        assert.equal(r.status, 200, 'answered at once - nothing queued');
        const body = await r.json();
        assert.deepEqual(body, { doc_id: first, title: 'floppy', status: 'existing' });
        const docs = await (await ada(`api/identity/${adaRoot}/docs`)).json();
        const rows = (docs.docs || docs).filter(
            (d) => d.title === 'floppy' || d.title === 'a different name',
        );
        assert.equal(
            rows.length,
            1,
            `one document, not two: ${JSON.stringify(rows.map((d) => d.title))}`,
        );
    });

    it('once that document is deleted, the same bytes make a new one', async () => {
        const del = await ada(`api/identity/${adaRoot}/docs/${first}`, { method: 'DELETE' });
        assert.ok(del.ok, `delete answered ${del.status}`);
        const r = await upload(ada, adaRoot, 'floppy again');
        assert.equal(r.status, 202, 'a deleted document is not "already had"');
        const again = (await r.json()).doc_id;
        assert.notEqual(again, first);
        await made(ada, adaRoot, again);
    });

    it('two tracks with one cover are two sounds whose thumbnail is the cover, stored once', async () => {
        const cleo = await makeUserFetch({ prefix: 'dupcleo' });
        const cleoRoot = (await (await cleo('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        const track = async (name) => {
            const r = await cleo(
                `api/identity/${cleoRoot}/docs/binary?title=${encodeURIComponent(name)}`,
                { method: 'POST', body: fs.readFileSync(path.join(SAMPLES, name)), file: true },
            );
            assert.equal(r.status, 202, `${name} is queued`);
            const id = (await r.json()).doc_id;
            await made(cleo, cleoRoot, id);
            return id;
        };
        const one = await track('buck-cover.mp3');
        const two = await track('buck-cover.m4a');
        assert.notEqual(one, two, 'different sounds are different documents');
        const thumb = async (id) =>
            Buffer.from(
                await (await cleo(`api/identity/${cleoRoot}/docs/${id}/thumb`)).arrayBuffer(),
            );
        const [a, b] = [await thumb(one), await thumb(two)];
        assert.ok(a.length > 0 && a.equals(b), 'both thumbnails are the one cover');
        // The tally counts a stored file once; each document's size counts every file it names.
        const tally = await (await cleo(`api/identity/${cleoRoot}/storage`)).json();
        assert.ok(
            tally.files_bytes < tally.docs[one] + tally.docs[two],
            `the cover is stored once: ${JSON.stringify(tally)}`,
        );
    });

    it("another persona's upload of the same bytes is its own", async () => {
        const bea = await makeUserFetch({ prefix: 'dupbea' });
        const beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        const r = await upload(bea, beaRoot, 'floppy');
        assert.equal(r.status, 202, 'never deduplicated across personas');
    });
});
