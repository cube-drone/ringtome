/*
    A body answers in parts (2026-10-11: a sound "that gets longer as it goes"): a browser learns
    an Ogg sound's length by asking for its last page, and seeks by asking for the bytes it wants.
    The body route answers a range with those bytes, and says on every whole answer that it can.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');

const SOUND = path.join(__dirname, '..', '..', '..', 'sample_media', 'buck-audio.mp3');

describe('a body answers in parts', function () {
    this.timeout(600000);

    let ada, root, doc, whole;

    before(async () => {
        ada = await makeUserFetch({ prefix: 'rangeada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        const r = await ada(`api/identity/${root}/docs/binary?title=buck`, {
            method: 'POST',
            body: fs.readFileSync(SOUND),
            file: true,
        });
        doc = (await r.json()).doc_id;
        for (let i = 0; i < 300; i++) {
            const b = await ada(`api/identity/${root}/docs/${doc}/body`);
            if (b.status === 200) {
                assert.equal(b.headers.get('accept-ranges'), 'bytes', 'a whole answer says it can');
                whole = Buffer.from(await b.arrayBuffer());
                return;
            }
            await new Promise((res) => setTimeout(res, 400));
        }
        assert.fail('the sound was never made');
    });

    it('a range is those bytes', async () => {
        const r = await ada(`api/identity/${root}/docs/${doc}/body`, {
            headers: { Range: 'bytes=100-199' },
        });
        assert.equal(r.status, 206);
        assert.equal(r.headers.get('content-range'), `bytes 100-199/${whole.length}`);
        assert.ok(Buffer.from(await r.arrayBuffer()).equals(whole.subarray(100, 200)));
    });

    it('the last page, as a browser asks for it, and the named twin answers the same', async () => {
        const r = await ada(`api/identity/${root}/docs/${doc}/body/buck.ogg`, {
            headers: { Range: 'bytes=-64' },
        });
        assert.equal(r.status, 206);
        assert.ok(Buffer.from(await r.arrayBuffer()).equals(whole.subarray(whole.length - 64)));
    });

    it('a range past the end is refused, and says how long the body is', async () => {
        const r = await ada(`api/identity/${root}/docs/${doc}/body`, {
            headers: { Range: `bytes=${whole.length}-` },
        });
        assert.equal(r.status, 416);
        assert.equal(r.headers.get('content-range'), `bytes */${whole.length}`);
    });
});
