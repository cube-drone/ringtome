/*
    The fence, carrying (plans/AUDIO.md, section 8, slice 10): on a node whose operator refuses
    tagged songs - artist or album set - another node's tagged song is neither fetched, kept nor
    served. The post still arrives and reads; the song's thumbnail still serves; an untagged song
    plays as ever; and the reader's hrseAmp keeps the row, saying it isn't carried here.

    Two nodes: bea posts on B, ada follows her from A, and A's operator turns the fence on and off.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');

const { HOST, HOST_B, sql, makeFetch } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));
const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};

(HOST_B ? describe : describe.skip)('the fence, carrying: tagged songs not kept here', function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, admin;
    let taggedTwin, plainTwin, taggedPost, taggedHash;

    const uploaded = async (who, root, title, file) => {
        const made = await (
            await who(`api/identity/${root}/docs/binary?title=${title}`, {
                method: 'POST',
                body: sample(file),
                file: true,
            })
        ).json();
        for (let i = 0; i < 240; i++) {
            if ((await who(`api/identity/${root}/docs/${made.doc_id}/body`)).status === 200)
                return made.doc_id;
            await wait(500);
        }
        throw new Error(`${title} never finished ingesting`);
    };
    const field = (who, root, doc, f, value) =>
        value
            ? j(
                  who,
                  `api/identity/${root}/docs/${doc}/annotations/fields/${encodeURIComponent(f)}`,
                  { value },
                  'PUT',
              )
            : who(`api/identity/${root}/docs/${doc}/annotations/fields/${encodeURIComponent(f)}`, {
                  method: 'DELETE',
              });
    // A post of one sound, published on B: its post id, and the twin its words embed.
    const posted = async (sound, title) => {
        const note = (
            await (
                await j(bea, `api/identity/${beaRoot}/docs`, {
                    title,
                    body: `listen\n\n![a song](/api/identity/${beaRoot}/docs/${sound}/body/song.opus)\n`,
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        const r = await j(bea, `api/identity/${beaRoot}/docs/${note}/publish`, {});
        const said = await r.text();
        assert.equal(r.status, 200, said);
        const post = JSON.parse(said).post_id;
        const words = await (await bea(`id/${beaRoot}/docs/${post}/body`)).text();
        return [post, (words.match(/\/doc\/([0-9a-f]{32})\//) || [])[1]];
    };
    const body = (doc) => ada(`id/${beaRoot}/docs/${doc}/body`);
    // On A: the twin's bytes arrive behind its post.
    const arrives = async (doc, tries = 40) => {
        for (let i = 0; i < tries; i++) {
            const r = await body(doc);
            if (r.status === 200) return r;
            await pullAndFold(HOST, beaRoot);
            await beat(HOST, 'bodies-sweep');
            await wait(400);
        }
        return body(doc);
    };
    const policy = async (on) => {
        const r = await j(admin, 'api/admin/audio-policy', { tagged: on }, 'PUT');
        assert.equal(r.status, 200, await r.text());
    };
    const held = async (hash) =>
        (await (await makeFetch(HOST)(`test/blob/${hash}`)).json()).present;
    const library = async () =>
        (await (await ada(`api/identity/${adaRoot}/amp/library`)).json()).sounds;

    before(async function () {
        ada = await makeUserFetch({ prefix: 'carryada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(ada, `api/identity/${adaRoot}/serve`, {});
        bea = await makeUserFetch({ prefix: 'carrybea', host: HOST_B });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(bea, `api/identity/${beaRoot}/serve`, {});
        admin = await makeUserFetch({ prefix: 'carryadmin' });
        await sql(
            `INSERT INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
        );
        if ((await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`)).status !== 200)
            this.skip();
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/interest`,
            { value: 'max' },
            'PUT',
        );

        const tagged = await uploaded(bea, beaRoot, 'giorgio', 'buck-audio.ogg');
        await field(bea, beaRoot, tagged, 'artist', 'Daft Punk');
        const plain = await uploaded(bea, beaRoot, 'memo', 'buck-audio.mp3');
        for (const f of ['artist', 'album']) await field(bea, beaRoot, plain, f, '');
        [taggedPost, taggedTwin] = await posted(tagged, 'Tagged');
        [, plainTwin] = await posted(plain, 'Plain');
        assert.ok(taggedTwin && plainTwin);

        // Before any fence: A carries both.
        const r = await arrives(taggedTwin);
        assert.equal(r.status, 200, 'the tagged song arrives while tagged songs are welcome');
        taggedHash = (r.headers.get('etag') || '').replace(/[W/"]/g, '').toLowerCase();
        assert.equal((await arrives(plainTwin)).status, 200);
    });

    after(async () => {
        if (admin) await policy(true);
    });

    it("the fence up: the tagged song isn't served, its thumbnail, its post and an untagged song are", async () => {
        await policy(false);
        const refused = await body(taggedTwin);
        assert.equal(refused.status, 404);
        const why = await refused.json();
        assert.equal(why.key, 'rights.not-carried-here', JSON.stringify(why));
        assert.equal(
            (await ada(`id/${beaRoot}/docs/${taggedTwin}/thumb`)).status,
            200,
            'the thumbnail',
        );
        assert.equal((await body(taggedPost)).status, 200, 'the words of the post');
        assert.equal((await body(plainTwin)).status, 200, 'an untagged song plays as ever');
    });

    it("hrseAmp keeps the row, saying it isn't carried here", async () => {
        let sounds = [];
        for (let i = 0; i < 30; i++) {
            await beat(HOST, 'journal-fill');
            sounds = await library();
            if (sounds.some((s) => s.doc === taggedTwin)) break;
            await wait(300);
        }
        const row = sounds.find((s) => s.doc === taggedTwin);
        assert.ok(row, JSON.stringify(sounds.map((s) => s.doc)));
        assert.equal(row.carried, false);
        assert.equal(sounds.find((s) => s.doc === plainTwin).carried, true);
    });

    it('the reaper lets the bytes go, and nothing fetches them back', async function () {
        if (!/^[0-9a-f]{64}$/.test(taggedHash)) this.skip();
        let present = true;
        for (let i = 0; i < 40 && present; i++) {
            await wait(500);
            present = await held(taggedHash);
        }
        assert.equal(present, false, 'gone at the next reaper round');
        await pullAndFold(HOST, beaRoot);
        await beat(HOST, 'bodies-sweep');
        await wait(1000);
        assert.equal(await held(taggedHash), false, 'not fetched again behind the fence');
    });

    it('the fence down: the song is fetched and served again', async () => {
        await policy(true);
        assert.equal((await arrives(taggedTwin)).status, 200);
    });
});
