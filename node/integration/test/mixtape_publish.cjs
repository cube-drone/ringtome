/*
    A mixtape, published (plans/MIXTAPES.md, slice 1): the kind, in public. A mixtape is a
    taxonomy; its draft is a note the node makes of it (`PUT .../amp/tapes/<id>/draft`), one
    embedded sound per track, and publishing that note - by the door every note takes - mints a
    post of the `mixtape` format whose body is the tracklist. The songs are published with it
    as the post's own media, so they go wherever the post goes: a follower's node holds them, and
    so does the node of somebody who only follows a person who rebroadcast it (Curtis, 2026-11-23:
    "you just get them automatically because you're part of a network that makes that available
    to you"). A feed shows the cassette and none of its songs. Taking a song off and publishing
    again takes that song down; taking the mixtape down takes them all. And thirty is the most a
    mixtape publishes.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold, shareArrives } = require('./beat.cjs');
const { HOST_B, HOST_C, makeFetch } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));

const base58 = async (who) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await who('api/node')).json()).endpoint_id);
};

(HOST_B && HOST_C ? describe : describe.skip)('a mixtape, published', function () {
    this.timeout(600000);

    const stranger = makeFetch();
    let ada, adaRoot, bea, beaRoot;
    let songA, songB, tape, draft, post;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch(host ? { prefix, host } : { prefix });
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
        [bea, beaRoot] = await persona('tapebea', HOST_B);
        assert.equal(
            (await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status,
            200,
            'bea finds ada',
        );
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

    // The draft as ada's own list has it: its fields, and the version it stands at.
    const draftRow = async () =>
        (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs.find(
            (d) => d.doc_id === draft,
        );

    it('the draft is stamped with the version that went out', async () => {
        const row = await draftRow();
        assert.equal(row.fields.published_as, post);
        assert.equal(row.fields.published_head, row.head, 'nothing to update yet');
        const labels = await (await stranger(`api/id/${adaRoot}/posts/${post}`)).text();
        assert.ok(!labels.includes(row.head), 'and the stamp is not a label on the post');
    });

    // Whether this reader's own node hands over a file of ada's.
    const holds = async (who, doc) => (await who(`id/${adaRoot}/docs/${doc}/body`)).status === 200;

    it("a follower's feed shows the mixtape and none of its songs, and her node holds every song", async () => {
        const tracks = (await tracklist()).map((t) => t.doc);
        let items = [];
        let held = false;
        for (let i = 0; i < 60 && !(held && items.some((it) => it.doc_id === post)); i++) {
            await pullAndFold(HOST_B, adaRoot);
            items = (await (await bea(`api/identity/${beaRoot}/feed`)).json()).items || [];
            held = (await Promise.all(tracks.map((t) => holds(bea, t)))).every(Boolean);
            if (!held) await wait(500);
        }
        const seen = items.map((i) => [i.doc_id, i.format]);
        assert.ok(
            items.some((it) => it.doc_id === post),
            `the mixtape is in bea's feed: ${JSON.stringify(seen)}`,
        );
        assert.equal(items.find((it) => it.doc_id === post).format, 'mixtape');
        assert.ok(
            !items.some((it) => tracks.includes(it.doc_id)),
            `no song is a post of its own: ${JSON.stringify(seen)}`,
        );
        assert.ok(held, "bea's node holds both songs");
    });

    it("her hrseAmp names the mixtape among her friends', and its songs as that post's", async () => {
        const tracks = (await tracklist()).map((t) => t.doc);
        let lib = {};
        for (let i = 0; i < 40; i++) {
            lib = await (await bea(`api/identity/${beaRoot}/amp/library`)).json();
            const songs = (lib.sounds || []).filter((x) => x.post === post);
            if ((lib.tapes || []).length && songs.length === tracks.length) break;
            await pullAndFold(HOST_B, adaRoot);
            await wait(500);
        }
        assert.deepEqual(
            (lib.tapes || []).map((x) => [x.author, x.post, x.title]),
            [[adaRoot, post, 'Road Songs']],
            JSON.stringify(lib.tapes),
        );
        assert.deepEqual(
            lib.sounds
                .filter((x) => x.post === post)
                .map((x) => x.doc)
                .sort(),
            [...tracks].sort(),
            "both songs are rows, come by the mixtape's post",
        );
        assert.ok(
            lib.sounds.filter((x) => x.post === post).every((x) => x.taped),
            "and each is marked a mixtape's, so it is no loose song of ada's",
        );
    });

    it("rebroadcast, it reaches the sharer's follower with its songs - who never followed ada", async () => {
        const [cal, calRoot] = await persona('tapecal', HOST_C);
        assert.equal(
            (await cal(`api/id/${beaRoot}/profile?via=${await base58(bea)}`)).status,
            200,
            'cal finds bea',
        );
        await j(
            cal,
            `api/identity/${calRoot}/private/kv/contact:${beaRoot}/interest_rebroadcasts`,
            { value: 'high' },
            'PUT',
        );
        const shared = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, {
            author: adaRoot,
            doc_id: post,
        });
        assert.equal(shared.status, 200, await shared.text());
        const tracks = (await tracklist()).map((t) => t.doc);
        let items = [];
        let held = [];
        for (let i = 0; i < 40; i++) {
            await shareArrives(HOST_C, beaRoot, adaRoot);
            items = (await (await cal(`api/identity/${calRoot}/feed`)).json()).items || [];
            held = await Promise.all(tracks.map((t) => holds(cal, t)));
            if (items.some((it) => it.doc_id === post) && held.every(Boolean)) break;
            await wait(500);
        }
        assert.ok(
            items.some((it) => it.doc_id === post && it.format === 'mixtape'),
            `the mixtape reached cal by bea's share: ${JSON.stringify(items.map((i) => [i.doc_id, i.format]))}`,
        );
        assert.deepEqual(held, [true, true], "and cal's node holds its songs");
        const lib = await (await cal(`api/identity/${calRoot}/amp/library`)).json();
        assert.deepEqual(
            (lib.tapes || []).map((x) => [x.author, x.post, x.via]),
            [[adaRoot, post, beaRoot]],
            `cal's hrseAmp names it, come through bea: ${JSON.stringify(lib.tapes)}`,
        );
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
        const row = await draftRow();
        assert.equal(row.fields.published_head, row.head, 'the stamp follows the new version');
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

/*
    Sealed (plans/MIXTAPES.md, slice 5): the same publish with the seal asked for. The tracklist
    and every song are sealed under the post's key, so a stranger gets neither, a follower on
    another node gets neither until the author trusts her - and then her own node hands her the
    tracklist and plays her the songs.
*/
(HOST_B ? describe : describe.skip)('a mixtape, sealed', function () {
    this.timeout(600000);

    const stranger = makeFetch();
    let ada, adaRoot, dee, deeRoot, post, tracks;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch(host ? { prefix, host } : { prefix });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(who, `api/identity/${root}/serve`, {});
        return [who, root];
    };

    before(async () => {
        [ada, adaRoot] = await persona('sealtapeada');
        [dee, deeRoot] = await persona('sealtapedee', HOST_B);
        const tape = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'mixtape:Quiet Songs' })
            ).json()
        ).taxonomy_id;
        for (const [title, file] of [
            ['First Song', 'buck-audio.ogg'],
            ['Second Song', 'buck-cover.opus'],
        ]) {
            const made = await (
                await ada(`api/identity/${adaRoot}/docs/binary?title=${title}`, {
                    method: 'POST',
                    body: sample(file),
                    file: true,
                })
            ).json();
            for (let i = 0; i < 240; i++) {
                if ((await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/body`)).status === 200)
                    break;
                await wait(500);
            }
            const put = await j(
                ada,
                `api/identity/${adaRoot}/taxonomies/${tape}/members/${made.doc_id}`,
                { member_root: adaRoot },
                'PUT',
            );
            assert.equal(put.status, 200, await put.text());
        }
        const drafted = await ada(`api/identity/${adaRoot}/amp/tapes/${tape}/draft`, {
            method: 'PUT',
        });
        assert.equal(drafted.status, 200, await drafted.clone().text());
        const draft = (await drafted.json()).doc_id;
        for (let i = 0; i < 200 && !post; i++) {
            const r = await j(ada, `api/identity/${adaRoot}/docs/${draft}/publish`, {
                trusted_only: true,
            });
            const said = await r.text();
            if (r.status === 200) post = JSON.parse(said).post_id;
            else {
                assert.ok(
                    r.status === 202 || said.includes('this-notes-words-havent-arrived'),
                    `${r.status} ${said}`,
                );
                await wait(500);
            }
        }
        assert.ok(post, 'published');
    });

    it('is a sealed post of the mixtape kind, whose author reads its tracklist', async () => {
        const head = await (await stranger(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.format, 'mixtape', JSON.stringify(head).slice(0, 300));
        assert.equal(head.trusted_only, true);
        const own = await ada(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(own.status, 200, await own.clone().text());
        tracks = (await own.json()).tracks;
        assert.equal(tracks.length, 2);
        assert.ok(
            tracks.every((t) => t.title && t.ms > 0),
            `each line says its song: ${JSON.stringify(tracks)}`,
        );
    });

    it('a stranger gets neither the tracklist nor a song', async () => {
        assert.notEqual((await stranger(`id/${adaRoot}/docs/${post}/body`)).status, 200);
        for (const t of tracks)
            assert.notEqual(
                (await stranger(`id/${adaRoot}/docs/${t.doc}/body`)).status,
                200,
                `${t.title} is sealed`,
            );
    });

    it('a follower on another node is refused until she is trusted, and then plays every song', async function () {
        if ((await dee(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200)
            this.skip();
        await j(
            dee,
            `api/identity/${deeRoot}/private/kv/contact:${adaRoot}/interest`,
            { value: 'max' },
            'PUT',
        );
        await pullAndFold(HOST_B, adaRoot);
        assert.notEqual(
            (await dee(`id/${adaRoot}/docs/${tracks[0].doc}/body`)).status,
            200,
            'no song for the untrusted, on any node',
        );
        const before = await (await dee(`api/identity/${deeRoot}/amp/library`)).json();
        assert.deepEqual(before.tapes, [], "nor is it in the untrusted reader's hrseAmp");
        assert.deepEqual(before.sounds, []);
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${deeRoot}/trust`,
            { value: 'high' },
            'PUT',
        );
        await beat(undefined, 'mint', adaRoot);
        await ada(`api/id/${deeRoot}/profile?via=${await base58(dee)}`);
        await pullAndFold(undefined, deeRoot);
        let list = null;
        let played = [];
        for (let i = 0; i < 60; i++) {
            await pullAndFold(HOST_B, adaRoot);
            const r = await dee(`id/${adaRoot}/docs/${post}/body`);
            if (r.status === 200) list = (await r.json()).tracks;
            played = [];
            for (const t of tracks) {
                const song = await dee(`id/${adaRoot}/docs/${t.doc}/body`);
                played.push(
                    song.status === 200
                        ? Buffer.from(await song.arrayBuffer())
                              .subarray(0, 4)
                              .toString('latin1')
                        : song.status,
                );
            }
            if (list && played.every((p) => p === 'OggS')) break;
            await wait(500);
        }
        assert.deepEqual(
            (list || []).map((t) => t.doc),
            tracks.map((t) => t.doc),
            'her node hands her the tracklist',
        );
        assert.deepEqual(played, ['OggS', 'OggS'], 'and each song, opened: an Ogg stream');
        const items = (await (await dee(`api/identity/${deeRoot}/feed`)).json()).items || [];
        assert.ok(
            items.some((it) => it.doc_id === post && it.format === 'mixtape'),
            `and it is in her feed: ${JSON.stringify(items.map((i) => [i.doc_id, i.format]))}`,
        );
        // And in her hrseAmp: the mixtape, marked sealed, and its songs as rows of that post.
        const lib = await (await dee(`api/identity/${deeRoot}/amp/library`)).json();
        assert.deepEqual(
            lib.tapes.map((x) => [x.author, x.post, x.sealed]),
            [[adaRoot, post, true]],
            JSON.stringify(lib.tapes),
        );
        assert.deepEqual(
            lib.sounds
                .filter((x) => x.post === post)
                .map((x) => x.doc)
                .sort(),
            tracks.map((t) => t.doc).sort(),
            `both sealed songs are rows: ${JSON.stringify(lib.sounds).slice(0, 400)}`,
        );
        assert.ok(
            lib.sounds.every((x) => x.duration_ms > 0),
            'each saying how long it plays',
        );
    });
});

/*
    A sealed mixtape with somebody else's song on it (Curtis, 2026-11-23: "unseal it and copy it
    into our own lane unencumbered"). That song is public already, so its copy in the mixtape's
    author's lane is public too; the tracklist and the author's own song stay under the key.
*/
describe("a mixtape, sealed, holding somebody else's song", function () {
    this.timeout(600000);

    const stranger = makeFetch();
    let ada, adaRoot, bea, beaRoot, theirs, post, tracks;

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
    const published = async (who, root, doc, body) => {
        for (let i = 0; i < 200; i++) {
            const r = await j(who, `api/identity/${root}/docs/${doc}/publish`, body);
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

    before(async () => {
        [ada, adaRoot] = await persona('lenttapeada');
        [bea, beaRoot] = await persona('lenttapebea');
        // Bea's song, public: a post of hers that embeds it.
        const hers = await uploaded(bea, beaRoot, 'Borrowed', 'buck-cover.opus');
        const note = (
            await (
                await j(bea, `api/identity/${beaRoot}/docs`, {
                    title: 'a song',
                    body: `![song](/api/identity/${beaRoot}/docs/${hers}/body/track.ogg)\n`,
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        const said = await published(bea, beaRoot, note, {});
        const words = await (await stranger(`id/${beaRoot}/docs/${said}/body`)).text();
        theirs = (words.match(/\/doc\/([0-9a-f]{32})\//) || [])[1];
        assert.ok(theirs, `bea's post embeds her public song: ${words}`);

        const tape = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'mixtape:Lent Songs' })
            ).json()
        ).taxonomy_id;
        const own = await uploaded(ada, adaRoot, 'Mine', 'buck-audio.ogg');
        for (const [doc, member_root] of [
            [own, adaRoot],
            [theirs, beaRoot],
        ]) {
            const put = await j(
                ada,
                `api/identity/${adaRoot}/taxonomies/${tape}/members/${doc}`,
                { member_root },
                'PUT',
            );
            assert.equal(put.status, 200, await put.text());
        }
        const drafted = await ada(`api/identity/${adaRoot}/amp/tapes/${tape}/draft`, {
            method: 'PUT',
        });
        assert.equal(drafted.status, 200, await drafted.clone().text());
        post = await published(ada, adaRoot, (await drafted.json()).doc_id, {
            trusted_only: true,
        });
    });

    it('publishes, sealed, with both songs on its tracklist', async () => {
        const head = await (await stranger(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.format, 'mixtape', JSON.stringify(head).slice(0, 300));
        assert.equal(head.trusted_only, true);
        const own = await ada(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(own.status, 200, await own.clone().text());
        tracks = (await own.json()).tracks;
        assert.equal(tracks.length, 2, JSON.stringify(tracks));
        assert.ok(
            tracks.every((t) => t.doc !== theirs),
            "the borrowed song is a copy in ada's lane, not bea's own",
        );
    });

    it("the borrowed song's copy is public; the tracklist and ada's own song are not", async () => {
        assert.notEqual((await stranger(`id/${adaRoot}/docs/${post}/body`)).status, 200);
        const got = [];
        for (const t of tracks) {
            const r = await stranger(`id/${adaRoot}/docs/${t.doc}/body`);
            got.push(
                r.status === 200
                    ? Buffer.from(await r.arrayBuffer())
                          .subarray(0, 4)
                          .toString('latin1')
                    : 'refused',
            );
        }
        assert.deepEqual(got, ['refused', 'OggS'], JSON.stringify(tracks));
    });
});
