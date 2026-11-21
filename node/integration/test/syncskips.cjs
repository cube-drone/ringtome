/*
    "Do not sync images / audio / video from this user" (2026-11-20, the relationship panel's
    storage section): a follower's private record of someone can decline a kind of their files.
    The node then leaves those files where they are - the post still arrives and reads, and the
    other kinds still come - and fetches them once the follower takes it back. Beside a declined
    kind, "delete existing" drops the files of that kind already here; a quarantined one is kept.

    Two nodes: bea posts a picture and a song on B; ada follows her from A, declining images.
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

(HOST_B ? describe : describe.skip)("a follower declines a kind of someone's files", function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, admin;
    let picturePost, pictureTwin, sealedTwin, songTwin;

    const uploaded = async (title, file) => {
        const made = await (
            await bea(`api/identity/${beaRoot}/docs/binary?title=${title}`, {
                method: 'POST',
                body: sample(file),
                file: true,
            })
        ).json();
        for (let i = 0; i < 240; i++) {
            if ((await bea(`api/identity/${beaRoot}/docs/${made.doc_id}/body`)).status === 200)
                return made.doc_id;
            await wait(500);
        }
        throw new Error(`${title} never finished ingesting`);
    };
    // A post of one file, published on B: its post id, and the twin its words embed.
    const posted = async (doc, title, name) => {
        const note = (
            await (
                await j(bea, `api/identity/${beaRoot}/docs`, {
                    title,
                    body: `look\n\n![it](/api/identity/${beaRoot}/docs/${doc}/body/${name})\n`,
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
    // On A: a file's bytes arrive behind its post.
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
    // Ada's record of bea, and A's memo of it catching up.
    const decline = async (key, value, bits, column = 'skip_kinds') => {
        const r = await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/${key}`,
            { value },
            'PUT',
        );
        assert.equal(r.status, 200, await r.text());
        let seen = null;
        for (let i = 0; i < 40 && seen !== bits; i++) {
            await beat(HOST, 'fold', adaRoot);
            const rows = (
                await sql(
                    `SELECT ${column} AS bits FROM subscriptions WHERE local_root = '${adaRoot}' AND foreign_root = '${beaRoot}'`,
                )
            ).rows;
            seen = rows.length ? rows[0].bits : null;
            if (seen !== bits) await wait(250);
        }
        assert.equal(seen, bits, "the node's memo of who declines what");
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: 'skipada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(ada, `api/identity/${adaRoot}/serve`, {});
        bea = await makeUserFetch({ prefix: 'skipbea', host: HOST_B });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(bea, `api/identity/${beaRoot}/serve`, {});
        if ((await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`)).status !== 200)
            this.skip();

        [picturePost, pictureTwin] = await posted(
            await uploaded('floppy', 'floppy.png'),
            'A picture',
            'floppy.avif',
        );
        [, songTwin] = await posted(
            await uploaded('memo', 'buck-audio.mp3'),
            'A song',
            'song.opus',
        );
        [, sealedTwin] = await posted(
            await uploaded('polaroid', 'polaroid.jpg'),
            'Another picture',
            'polaroid.avif',
        );
        assert.ok(pictureTwin && songTwin && sealedTwin);
        admin = await makeUserFetch({ prefix: 'skipadmin' });
        await sql(
            `INSERT INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
        );
    });

    it('images declined: the post and the song arrive, the picture does not', async () => {
        // Following, and declining images in the same breath.
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/sync_skip_pictures`,
            { value: 'yes' },
            'PUT',
        );
        await decline('interest', 'max', 1);

        assert.equal((await arrives(songTwin)).status, 200, 'the song is not an image');
        assert.equal((await arrives(picturePost)).status, 200, 'the words of the post');
        // The song proved the lane is open; a few more rounds give the picture every chance.
        const picture = await arrives(pictureTwin, 4);
        assert.notEqual(picture.status, 200, 'the picture was left where it is');
    });

    it('taken back: the picture comes', async () => {
        await decline('sync_skip_pictures', 'no', 0);
        assert.equal((await arrives(pictureTwin)).status, 200);
    });

    it('delete existing images: the pictures here go, but never a quarantined one, and never the song', async () => {
        const hashOf = async (doc) => {
            const r = await arrives(doc);
            assert.equal(r.status, 200);
            return (r.headers.get('etag') || '').replace(/[W/"]/g, '').toLowerCase();
        };
        const held = async (hash) =>
            (await (await makeFetch(HOST)(`test/blob/${hash}`)).json()).present;
        const [picture, sealed, song] = [
            await hashOf(pictureTwin),
            await hashOf(sealedTwin),
            await hashOf(songTwin),
        ];
        assert.match(picture, /^[0-9a-f]{64}$/);
        assert.ok((await held(picture)) && (await held(sealed)) && (await held(song)));

        // The operator quarantines one of them: kept, whatever anyone asks.
        const q = await j(admin, 'api/admin/quarantine', {
            address: `/ringtome/user/${beaRoot}/doc/${sealedTwin}/body`,
            why: 'kept for the record',
        });
        assert.equal(q.status, 200, await q.clone().text());

        // Asked for without the decline, it is nothing.
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/sync_purge_pictures`,
            { value: 'yes' },
            'PUT',
        );
        await decline('sync_skip_pictures', 'yes', 1, 'purge_kinds');

        let gone = false;
        for (let i = 0; i < 60 && !gone; i++) {
            gone = !(await held(picture));
            if (!gone) await wait(500);
        }
        assert.ok(gone, "the picture's bytes were collected");
        // A quarantined blob reads as absent to everything, so ask whether its bytes are kept -
        // and give the reaper rounds enough to have taken them if it were going to.
        const kept = async (hash) =>
            (await (await makeFetch(HOST)(`test/blob/${hash}`)).json()).kept;
        await wait(5000);
        assert.equal(await kept(sealed), true, 'the quarantined picture is kept');
        assert.equal(await kept(picture), false, 'where the other is gone from the disk');
        assert.equal(await held(song), true, 'and the song was never asked about');
        // And it stays gone: declined, it is not fetched again.
        await pullAndFold(HOST, beaRoot);
        await beat(HOST, 'bodies-sweep');
        assert.equal(await held(picture), false);
    });

    after(async () => {
        if (!admin) return;
        const rows = (await (await admin('api/admin/quarantine')).json()).rows || [];
        for (const row of rows.filter((r) => !r.released_ms)) {
            await admin(`api/admin/quarantine/${row.hash}/release`, { method: 'POST' });
        }
    });
});
