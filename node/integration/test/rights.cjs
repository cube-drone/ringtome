/*
    Rights (plans/AUDIO.md, section 8): a tagged song is one whose artist or album is set (ruling
    15). The sign (ruling 16): the node says which tagged songs a draft carries - its author's own,
    or someone else's copied in - for the app to ask about; it doesn't check the answer. The fence
    (ruling 17): an operator who says no refuses a post carrying one at publish, for everyone here.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');
const { sql } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));

describe('rights: the sign and the fence', function () {
    this.timeout(300000);

    let ada, adaRoot, admin, tagged, plain, taggedNote, plainNote;

    const persona = async (prefix) => {
        const who = await makeUserFetch({ prefix });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(who, `api/identity/${root}/serve`, {});
        return [who, root];
    };
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
    const setField = (who, root, doc, field, value) =>
        j(
            who,
            `api/identity/${root}/docs/${doc}/annotations/fields/${encodeURIComponent(field)}`,
            {
                value,
            },
            'PUT',
        );
    const clearField = (who, root, doc, field) =>
        who(`api/identity/${root}/docs/${doc}/annotations/fields/${encodeURIComponent(field)}`, {
            method: 'DELETE',
        });
    const note = async (who, root, title, sound) =>
        (
            await (
                await j(who, `api/identity/${root}/docs`, {
                    title,
                    body: `listen\n\n![a song](/api/identity/${root}/docs/${sound}/body/song.opus)\n`,
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
    const ask = async (who, root, body) => {
        const r = await j(who, `api/identity/${root}/tagged-songs`, body);
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
    };
    const policy = async (tagged_) => {
        const r = await j(admin, 'api/admin/audio-policy', { tagged: tagged_ }, 'PUT');
        assert.equal(r.status, 200, await r.text());
    };

    before(async () => {
        [ada, adaRoot] = await persona('rightsada');
        admin = await makeUserFetch({ prefix: 'rightsadmin' });
        await sql(
            `INSERT INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
        );
        tagged = await uploaded(ada, adaRoot, 'giorgio', 'buck-audio.ogg');
        plain = await uploaded(ada, adaRoot, 'memo', 'buck-audio.mp3');
        // Whatever the samples said about themselves, these say what the claims need.
        for (const f of ['artist', 'album']) {
            await clearField(ada, adaRoot, tagged, f);
            await clearField(ada, adaRoot, plain, f);
        }
        await setField(ada, adaRoot, tagged, 'track', 'Giorgio by Moroder');
        await setField(ada, adaRoot, tagged, 'artist', 'Daft Punk');
        await setField(ada, adaRoot, plain, 'track', 'Voice memo');
        taggedNote = await note(ada, adaRoot, 'Tagged', tagged);
        plainNote = await note(ada, adaRoot, 'Plain', plain);
    });

    // The policy is node-wide: whatever a claim set, the next file finds it open.
    after(async () => {
        if (admin) await policy(true);
    });

    it('names the tagged songs a draft carries - artist or album, not a title alone', async () => {
        const one = await ask(ada, adaRoot, { docs: [taggedNote] });
        assert.deepEqual(one.songs, [
            { title: 'Giorgio by Moroder', artist: 'Daft Punk', album: '' },
        ]);
        assert.equal(one.allowed, true, 'this server publishes them, until its operator says no');
        const none = await ask(ada, adaRoot, { docs: [plainNote] });
        assert.deepEqual(none.songs, [], 'a voice memo with a title is no tagged song');
    });

    it("asks of a notebook's pages, for a book's rollout", async () => {
        await ada(`api/identity/${adaRoot}/docs/${taggedNote}/buckets/Mixtape%20Book`, {
            method: 'PUT',
        });
        const book = await ask(ada, adaRoot, { bucket: 'Mixtape Book' });
        assert.equal(book.songs.length, 1);
    });

    it('the sign is only a sign: the node publishes a tagged song without asking', async () => {
        const r = await j(ada, `api/identity/${adaRoot}/docs/${taggedNote}/publish`, {});
        assert.equal(r.status, 200, await r.text());
    });

    it("the fence: an operator's no refuses a tagged song at publish, and only a tagged one", async () => {
        await policy(false);
        const said = await (await admin('api/admin/audio-policy')).json();
        assert.equal(said.tagged, false);
        assert.equal((await ask(ada, adaRoot, { docs: [taggedNote] })).allowed, false);
        // A draft edited since its first publish, so this is a fresh publish of tagged sound.
        const again = await note(ada, adaRoot, 'Tagged again', tagged);
        const refused = await j(ada, `api/identity/${adaRoot}/docs/${again}/publish`, {});
        assert.equal(refused.status, 400);
        const why = await refused.text();
        assert.ok(/operator/.test(why) && /Giorgio/.test(why), why);
        const fine = await j(ada, `api/identity/${adaRoot}/docs/${plainNote}/publish`, {});
        assert.equal(fine.status, 200, await fine.text());
        await policy(true);
        const now = await j(ada, `api/identity/${adaRoot}/docs/${again}/publish`, {});
        assert.equal(now.status, 200, await now.text());
    });

    it('only an administrator sets the fence', async () => {
        const r = await j(ada, 'api/admin/audio-policy', { tagged: false }, 'PUT');
        assert.ok([401, 403].includes(r.status), `refused: ${r.status}`);
    });

    it("counts someone else's tagged song copied into a draft, by what its author said", async () => {
        const [bea, beaRoot] = await persona('rightsbea');
        const song = await uploaded(bea, beaRoot, 'theirs', 'buck-audio.m4a');
        await setField(bea, beaRoot, song, 'album', 'Random Access Memories');
        const theirs = await note(bea, beaRoot, 'Theirs', song);
        const pub = await j(bea, `api/identity/${beaRoot}/docs/${theirs}/publish`, {});
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        const words = await (
            await bea(`id/${beaRoot}/docs/${JSON.parse(said).post_id}/body`)
        ).text();
        const twin = (words.match(/\/doc\/([0-9a-f]{32})\//) || [])[1];
        assert.ok(twin, words);
        const copy = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'Heard',
                    body: `![theirs](/id/${beaRoot}/docs/${twin}/body/song.opus)\n`,
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        let songs = [];
        for (let i = 0; i < 30 && !songs.length; i++) {
            songs = (await ask(ada, adaRoot, { docs: [copy] })).songs;
            if (!songs.length) await wait(300);
        }
        assert.equal(songs.length, 1, 'the copy is asked about too');
        assert.equal(songs[0].album, 'Random Access Memories');
    });
});
