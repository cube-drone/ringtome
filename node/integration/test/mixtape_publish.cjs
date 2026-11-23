/*
    A mixtape, published (plans/MIXTAPES.md, slice 1): the kind, in public. A mixtape is a
    taxonomy; its draft is a note the node makes of it (`PUT .../amp/tapes/<id>/draft`), one
    embedded sound per track, and publishing that note - by the door every note takes - mints a
    post of the `mixtape` format whose body is the tracklist. The songs are published with it,
    each its own public file, named by the tracklist and by nothing else: a follower's feed shows
    the cassette and none of its songs. Taking a song off and publishing again takes that song
    down; taking the mixtape down takes them all. And thirty is the most a mixtape publishes.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, makeFetch } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));

describe('a mixtape, published', function () {
    this.timeout(600000);

    const stranger = makeFetch();
    let ada, adaRoot, bea, beaRoot;
    let songA, songB, tape, draft, post;

    const persona = async (prefix) => {
        const who = await makeUserFetch({ prefix });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(who, `api/identity/${root}/serve`, {});
        return [who, root];
    };
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
    const onTape = (doc, on = true) =>
        on
            ? j(
                  ada,
                  `api/identity/${adaRoot}/taxonomies/${tape}/members/${doc}`,
                  { member_root: adaRoot },
                  'PUT',
              )
            : ada(
                  `api/identity/${adaRoot}/taxonomies/${tape}/members/${doc}?member_root=${adaRoot}`,
                  {
                      method: 'DELETE',
                  },
              );
    const drafted = async () => {
        const r = await ada(`api/identity/${adaRoot}/amp/tapes/${tape}/draft`, { method: 'PUT' });
        const said = await r.text();
        assert.equal(r.status, 200, said);
        return JSON.parse(said);
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
    const tracklist = async () => {
        const r = await stranger(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(r.status, 200, `the mixtape's words: ${r.status}`);
        return (await r.json()).tracks;
    };
    const stands = async (doc) => (await stranger(`id/${adaRoot}/docs/${doc}/body`)).status === 200;

    before(async () => {
        [ada, adaRoot] = await persona('tapeada');
        [bea, beaRoot] = await persona('tapebea');
        await j(
            bea,
            `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`,
            { value: 'max' },
            'PUT',
        );
        songA = await uploaded('First Song', 'buck-audio.ogg');
        songB = await uploaded('Second Song', 'buck-cover.opus');
        // A song's own fields are what its line says (a file's tags name it before its title does).
        const field = (doc, name, value) =>
            ada(`api/identity/${adaRoot}/docs/${doc}/annotations/fields/${name}`, {
                method: 'PUT',
                body: JSON.stringify({ value }),
            });
        await field(songA, 'track', 'First Song');
        await field(songA, 'artist', 'Bucks Unlimited');
        await field(songB, 'track', 'Second Song');
        tape = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'mixtape:Road Songs' })
            ).json()
        ).taxonomy_id;
    });

    it('an empty mixtape has nothing to publish', async () => {
        const r = await ada(`api/identity/${adaRoot}/amp/tapes/${tape}/draft`, { method: 'PUT' });
        assert.equal(r.status, 400, await r.text());
    });

    it("publishes as one post of its own kind: a tracklist, in the mixtape's order", async () => {
        assert.equal((await onTape(songA)).status, 200);
        assert.equal((await onTape(songB)).status, 200);
        const made = await drafted();
        assert.equal(made.tracks, 2);
        draft = made.doc_id;
        assert.equal((await drafted()).doc_id, draft, 'the same draft, asked for again');
        post = await published(draft);

        const head = await (await stranger(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.format, 'mixtape', JSON.stringify(head).slice(0, 300));
        assert.equal(head.title, 'Road Songs', "the post's title is the mixtape's name");
        const tracks = await tracklist();
        assert.equal(tracks.length, 2);
        assert.equal(tracks[0].title, 'First Song');
        assert.equal(tracks[0].artist, 'Bucks Unlimited', "a song's fields, on its line");
        assert.equal(tracks[1].title, 'Second Song');
        assert.ok(tracks[0].ms > 0, 'and how long it plays');
        assert.notEqual(tracks[0].doc, songA, 'a public copy, never the private sound');
        for (const t of tracks) assert.ok(await stands(t.doc), `track ${t.title} is served`);
    });

    it("a follower's feed shows the mixtape, and none of its songs", async () => {
        let items = [];
        for (let i = 0; i < 60; i++) {
            await beat(HOST, 'fold', adaRoot);
            items = (await (await bea(`api/identity/${beaRoot}/feed`)).json()).items || [];
            if (items.some((it) => it.doc_id === post)) break;
            await wait(500);
        }
        const mine = items.filter((it) => it.author_root === adaRoot || it.root === adaRoot);
        assert.ok(
            items.some((it) => it.doc_id === post),
            `the mixtape is in bea's feed: ${JSON.stringify(items.map((i) => [i.doc_id, i.format]))}`,
        );
        const tracks = (await tracklist()).map((t) => t.doc);
        assert.ok(
            !items.some((it) => tracks.includes(it.doc_id)),
            `no song is a post of its own: ${JSON.stringify(mine.map((i) => [i.doc_id, i.format]))}`,
        );
        assert.equal(items.find((it) => it.doc_id === post).format, 'mixtape');
    });

    it('a song taken off and the mixtape published again: the song is taken down', async () => {
        const [first, second] = await tracklist();
        assert.equal((await onTape(songB, false)).status, 200);
        await drafted();
        const again = await published(draft);
        assert.equal(again, post, 'the same post, at a new version');
        const tracks = await tracklist();
        assert.deepEqual(
            tracks.map((t) => t.doc),
            [first.doc],
            'the tracklist names what is left',
        );
        assert.ok(await stands(first.doc), 'the song still on it stands');
        assert.ok(!(await stands(second.doc)), 'the one taken off is gone');
    });

    it('thirty is the most a mixtape publishes', async () => {
        const big = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'mixtape:Too Long' })
            ).json()
        ).taxonomy_id;
        // Thirty-one members: the count is refused before anything is read, so notes will do.
        for (let i = 0; i < 31; i++) {
            const note = (
                await (
                    await j(ada, `api/identity/${adaRoot}/docs`, {
                        title: `n${i}`,
                        body: 'x',
                        format: 'marquee',
                    })
                ).json()
            ).doc_id;
            const put = await j(
                ada,
                `api/identity/${adaRoot}/taxonomies/${big}/members/${note}`,
                { member_root: adaRoot },
                'PUT',
            );
            assert.equal(put.status, 200, await put.text());
        }
        const r = await ada(`api/identity/${adaRoot}/amp/tapes/${big}/draft`, { method: 'PUT' });
        const said = await r.text();
        assert.equal(r.status, 400, said);
        assert.match(said, /too large to publish \(>30 tracks\)/);
    });

    it('taken down, its songs go with it', async () => {
        const [only] = await tracklist();
        const down = await ada(`api/identity/${adaRoot}/posts/${post}`, { method: 'DELETE' });
        assert.equal(down.status, 200, await down.text());
        assert.ok(!(await stands(post)), 'the mixtape is gone');
        assert.ok(!(await stands(only.doc)), 'and so is its song');
    });
});
