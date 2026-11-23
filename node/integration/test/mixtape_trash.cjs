/*
    hrseAmp's trash (plans/MIXTAPES.md, section 3; Curtis, 2026-11-22): "A user can delete a shared
    mixtape, or a single shared track from another user, removing it from their storage (if that
    was the only copy). Deleted shared tracks go into a 'trash' row in hrseAmp, where the user can
    choose to undelete them (re-requesting them from the original source)."

    Two nodes: ada publishes a mixtape of two songs and a third song on its own, on B; dee follows
    her from A. A song dee throws away leaves her hrseAmp for its trash and its file leaves her
    node, and is not fetched again; undeleted, it comes back from ada. A mixtape goes with its
    songs, and comes back with them.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('node:fs');
const path = require('node:path');

const { HOST, HOST_B, makeFetch } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));
const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};

(HOST_B ? describe : describe.skip)('a mixtape, in the trash', function () {
    this.timeout(600000);

    let ada, adaRoot, dee, deeRoot;
    let tapePost, tracks, loose, hashes;

    const uploaded = async (title, file) => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs/binary?title=${title}`, {
                method: 'POST',
                body: sample(file),
                file: true,
            })
        ).json();
        for (let i = 0; i < 240; i++) {
            if ((await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/body`)).status === 200)
                return made.doc_id;
            await wait(500);
        }
        throw new Error(`${title} never finished ingesting`);
    };
    const published = async (doc) => {
        for (let i = 0; i < 200; i++) {
            const r = await j(ada, `api/identity/${adaRoot}/docs/${doc}/publish`, {});
            const said = await r.text();
            if (r.status === 200) return JSON.parse(said).post_id;
            assert.ok(
                r.status === 202 || said.includes('this-notes-words-havent-arrived'),
                `${r.status} ${said}`,
            );
            await wait(500);
        }
        throw new Error('never published');
    };
    const body = (doc) => dee(`id/${adaRoot}/docs/${doc}/body`);
    // On A: a file's bytes arrive behind its post.
    const arrives = async (doc, tries = 40) => {
        for (let i = 0; i < tries; i++) {
            const r = await body(doc);
            if (r.status === 200) return r;
            await pullAndFold(HOST, adaRoot);
            await beat(HOST, 'bodies-sweep');
            await wait(400);
        }
        return body(doc);
    };
    const hashOf = async (doc) => {
        const r = await arrives(doc);
        assert.equal(r.status, 200, `${doc} arrived`);
        return (r.headers.get('etag') || '').replace(/[W/"]/g, '').toLowerCase();
    };
    // Whether A holds a file's bytes.
    const held = async (hash) =>
        (await (await makeFetch(HOST)(`test/blob/${hash}`)).json()).present;
    const leaves = async (hash) => {
        for (let i = 0; i < 80; i++) {
            if (!(await held(hash))) return true;
            await wait(500);
        }
        return false;
    };
    const returns = async (hash) => {
        for (let i = 0; i < 60; i++) {
            if (await held(hash)) return true;
            await pullAndFold(HOST, adaRoot);
            await beat(HOST, 'bodies-sweep');
            await wait(400);
        }
        return false;
    };
    const library = async () => (await dee(`api/identity/${deeRoot}/amp/library`)).json();
    const trash = (items, door = 'amp/trash') =>
        j(dee, `api/identity/${deeRoot}/${door}`, { items });

    before(async function () {
        dee = await makeUserFetch({ prefix: 'trashdee' });
        deeRoot = (await (await dee('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(dee, `api/identity/${deeRoot}/serve`, {});
        ada = await makeUserFetch({ prefix: 'trashada', host: HOST_B });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(ada, `api/identity/${adaRoot}/serve`, {});
        if ((await dee(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200)
            this.skip();

        const tape = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'mixtape:Bin Songs' })
            ).json()
        ).taxonomy_id;
        for (const [title, file] of [
            ['First Song', 'buck-audio.ogg'],
            ['Second Song', 'buck-cover.opus'],
        ]) {
            const put = await j(
                ada,
                `api/identity/${adaRoot}/taxonomies/${tape}/members/${await uploaded(title, file)}`,
                { member_root: adaRoot },
                'PUT',
            );
            assert.equal(put.status, 200, await put.text());
        }
        const drafted = await ada(`api/identity/${adaRoot}/amp/tapes/${tape}/draft`, {
            method: 'PUT',
        });
        assert.equal(drafted.status, 200, await drafted.clone().text());
        tapePost = await published((await drafted.json()).doc_id);
        tracks = (await (await ada(`id/${adaRoot}/docs/${tapePost}/body`)).json()).tracks;
        assert.equal(tracks.length, 2);

        const third = await uploaded('Loose Song', 'buck-audio.mp3');
        const note = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'a song on its own',
                    body: `![loose](/api/identity/${adaRoot}/docs/${third}/body/track.ogg)\n`,
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        const loosePost = await published(note);
        const words = await (await ada(`id/${adaRoot}/docs/${loosePost}/body`)).text();
        loose = (words.match(/\/doc\/([0-9a-f]{32})\//) || [])[1];
        assert.ok(loose, `the post embeds the song's public copy: ${words}`);

        await j(
            dee,
            `api/identity/${deeRoot}/private/kv/contact:${adaRoot}/interest`,
            { value: 'max' },
            'PUT',
        );
        await beat(HOST, 'fold', deeRoot);
        hashes = {
            loose: await hashOf(loose),
            first: await hashOf(tracks[0].doc),
            second: await hashOf(tracks[1].doc),
        };
        for (const h of Object.values(hashes)) assert.match(h, /^[0-9a-f]{64}$/);
    });

    it('a song thrown away leaves her hrseAmp for its trash, and its file leaves her node', async () => {
        const before = await library();
        assert.ok(
            before.sounds.some((s) => s.doc === loose),
            `the song is in her library: ${JSON.stringify(before.sounds.map((s) => s.doc))}`,
        );
        assert.deepEqual(before.trash, []);
        const own = await trash([{ author: deeRoot, doc: loose }]);
        assert.equal(own.status, 400, 'her own files are not what the trash is for');

        const r = await trash([{ author: adaRoot, doc: loose, title: 'Loose Song' }]);
        assert.equal(r.status, 200, await r.text());
        const after = await library();
        assert.ok(!after.sounds.some((s) => s.doc === loose), 'out of her table');
        assert.deepEqual(
            after.trash.map((x) => [x.author, x.doc, x.kind, x.title]),
            [[adaRoot, loose, 'song', 'Loose Song']],
        );
        assert.equal(after.tapes.length, 1, "ada's mixtape is untouched");
        assert.ok(await leaves(hashes.loose), "the song's bytes were collected");
        // And it stays gone: trashed, it is not fetched again.
        await pullAndFold(HOST, adaRoot);
        await beat(HOST, 'bodies-sweep');
        assert.equal(await held(hashes.loose), false);
        assert.ok(
            (await held(hashes.first)) && (await held(hashes.second)),
            "the mixtape's songs were never asked about",
        );
    });

    it('undeleted, it is asked for again and comes back', async () => {
        const r = await trash([{ author: adaRoot, doc: loose }], 'amp/trash/restore');
        assert.equal(r.status, 200, await r.text());
        const lib = await library();
        assert.deepEqual(lib.trash, []);
        assert.ok(
            lib.sounds.some((s) => s.doc === loose),
            'back in her table',
        );
        assert.ok(await returns(hashes.loose), 'and its bytes came back from ada');
    });

    it('a mixtape thrown away goes with its songs, and comes back with them', async () => {
        const r = await trash([
            { author: adaRoot, doc: tapePost, kind: 'mixtape', title: 'Bin Songs' },
            ...tracks.map((t) => ({
                author: adaRoot,
                doc: t.doc,
                title: t.title,
                tape: tapePost,
            })),
        ]);
        assert.equal(r.status, 200, await r.text());
        const gone = await library();
        assert.deepEqual(gone.tapes, [], "out of her friends' mixtapes");
        assert.deepEqual(
            gone.sounds.map((s) => s.doc),
            [loose],
            'its songs out of her table, the loose one still there',
        );
        assert.deepEqual(
            gone.trash.map((x) => [x.doc, x.kind, x.title, x.songs]),
            [[tapePost, 'mixtape', 'Bin Songs', 2]],
            'one line for the mixtape, its songs counted on it',
        );
        assert.ok((await leaves(hashes.first)) && (await leaves(hashes.second)));
        assert.equal(await held(hashes.loose), true, 'the loose song stays');

        const back = await trash([{ author: adaRoot, doc: tapePost }], 'amp/trash/restore');
        assert.equal(back.status, 200, await back.text());
        const lib = await library();
        assert.deepEqual(lib.trash, []);
        assert.deepEqual(
            lib.tapes.map((x) => x.post),
            [tapePost],
        );
        assert.ok((await returns(hashes.first)) && (await returns(hashes.second)));
    });
});
