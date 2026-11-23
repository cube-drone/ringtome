/*
    A mixtape, in a group (plans/MIXTAPES.md, slice 6): the mixtape's draft goes through the
    group's own publish door, which makes a post of the `mixtape` kind on the poster's lane for
    the group - its songs the group's media documents, its words their list. Bea posts one to the
    Tape Swap; ada's node, a member's, lists it as a mixtape, reads its tracklist and plays its
    songs through the group's door. Nothing public serves it. A song taken off and the mixtape
    published again takes that song down in the group; taking the mixtape down takes the rest.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, makeFetch } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));

(HOST_B ? describe : describe.skip)('a mixtape, in a group', function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, group, tape, draft, post, songs, tracks;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch(host ? { prefix, host } : { prefix });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };
    const act = async (who, root, p, body = {}) => {
        const res = await j(who, `api/identity/${root}/groups/${group}/${p}`, body);
        const text = await res.text();
        assert.equal(res.status, 200, `${p}: ${text}`);
        return JSON.parse(text);
    };
    const synced = async () => {
        await act(bea, beaRoot, 'sync');
        await act(ada, adaRoot, 'sync');
    };
    // The group's page at ada's node.
    const page = async () => {
        for (const r of [adaRoot, beaRoot]) await beat(HOST, 'fold', r);
        const res = await ada(`api/identity/${adaRoot}/groups/${group}/posts`);
        assert.equal(res.status, 200);
        return (await res.json()).posts;
    };
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
    const onTape = (doc, on = true) =>
        on
            ? j(
                  bea,
                  `api/identity/${beaRoot}/taxonomies/${tape}/members/${doc}`,
                  { member_root: beaRoot },
                  'PUT',
              )
            : bea(
                  `api/identity/${beaRoot}/taxonomies/${tape}/members/${doc}?member_root=${beaRoot}`,
                  { method: 'DELETE' },
              );
    const drafted = async () => {
        const r = await bea(`api/identity/${beaRoot}/amp/tapes/${tape}/draft`, { method: 'PUT' });
        assert.equal(r.status, 200, await r.clone().text());
        return (await r.json()).doc_id;
    };
    // A song through the group's door at ada's node: its first four bytes, or the status.
    const heard = async (doc) => {
        const r = await ada(`api/groups/${group}/docs/${doc}/body`);
        return r.status === 200
            ? Buffer.from(await r.arrayBuffer())
                  .subarray(0, 4)
                  .toString('latin1')
            : r.status;
    };

    before(async () => {
        [ada, adaRoot] = await persona('grouptapeada');
        [bea, beaRoot] = await persona('grouptapebea', HOST_B);
        group = (
            await (await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Tape Swap' })).json()
        ).group;
        const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
        await act(bea, beaRoot, 'join', {
            invite: token.invite,
            founder: token.founder,
            inviter: token.inviter,
            via: token.via,
        });
        await act(ada, adaRoot, 'sync');
        tape = (
            await (
                await j(bea, `api/identity/${beaRoot}/taxonomies`, { title: 'mixtape:Swap Songs' })
            ).json()
        ).taxonomy_id;
        songs = [
            await uploaded('First Song', 'buck-audio.ogg'),
            await uploaded('Second Song', 'buck-cover.opus'),
        ];
        for (const s of songs) assert.equal((await onTape(s)).status, 200);
        draft = await drafted();
    });

    it("posts as a mixtape on the group's page at another member's node", async () => {
        post = (await act(bea, beaRoot, 'publish', { doc: draft })).post;
        await synced();
        const there = (await page()).find((p) => p.doc === post);
        assert.ok(there, 'the mixtape is on the group page at ada');
        assert.equal(there.format, 'mixtape');
        assert.equal(there.title, 'Swap Songs');
        assert.equal(there.author, beaRoot);
        let words = there.words;
        for (let i = 0; i < 60 && !words; i++) {
            await wait(500);
            words = ((await page()).find((p) => p.doc === post) || {}).words;
        }
        tracks = JSON.parse(words).tracks;
        assert.equal(tracks.length, 2, words);
        assert.deepEqual(
            tracks.map((t) => t.doc),
            there.media,
            "the tracklist names the group's media documents, in order",
        );
        assert.ok(
            tracks.every((t) => t.title && t.ms > 0),
            `each line says its song: ${words}`,
        );
        assert.equal(
            (await page()).filter((p) => tracks.some((t) => t.doc === p.doc)).length,
            0,
            'and no song is a post of its own',
        );
    });

    it("plays there through the group's door, and is in her feed as a mixtape", async () => {
        let got = [];
        for (let i = 0; i < 120; i++) {
            got = [];
            for (const t of tracks) got.push(await heard(t.doc));
            if (got.every((g) => g === 'OggS')) break;
            await wait(500);
        }
        assert.deepEqual(got, ['OggS', 'OggS']);
        const items = (await (await ada(`api/identity/${adaRoot}/feed`)).json()).items || [];
        const row = items.find((it) => it.doc_id === post);
        assert.ok(row, `in her feed: ${JSON.stringify(items.map((i) => [i.doc_id, i.format]))}`);
        assert.equal(row.format, 'mixtape');
        assert.equal(row.group && row.group.id, group);
    });

    it("her hrseAmp lists it under the group, and its songs as rows the group's door plays", async () => {
        const lib = await (await ada(`api/identity/${adaRoot}/amp/library`)).json();
        assert.deepEqual(
            lib.tapes.map((x) => [x.author, x.post, x.title, x.group]),
            [[beaRoot, post, 'Swap Songs', { id: group, name: 'Tape Swap' }]],
            JSON.stringify(lib.tapes),
        );
        const rows = lib.sounds.filter((x) => x.post === post);
        assert.deepEqual(
            rows.map((x) => [x.doc, x.group, x.title]),
            tracks.map((t) => [t.doc, group, t.title]),
            JSON.stringify(lib.sounds).slice(0, 400),
        );
        assert.ok(
            rows.every((x) => x.duration_ms > 0 && x.taped),
            "each says how long it plays, and is the mixtape's",
        );
        // Bea's own is not among her friends': it is her mixtape, and she posted it.
        const hers = await (await bea(`api/identity/${beaRoot}/amp/library`)).json();
        assert.deepEqual(hers.tapes, []);
        const posted = await (await bea(`api/identity/${beaRoot}/docs/${draft}/groups`)).json();
        assert.deepEqual(
            posted.map((x) => [x.group, x.post, x.name]),
            [[group, post, 'Tape Swap']],
        );
    });

    it('nothing public serves it', async () => {
        const anon = makeFetch(HOST_B);
        for (const doc of [post, ...tracks.map((t) => t.doc)]) {
            assert.equal((await anon(`id/${beaRoot}/docs/${doc}/body`)).status, 404);
            assert.notEqual((await anon(`api/groups/${group}/docs/${doc}/body`)).status, 200);
        }
    });

    it('a song taken off and the mixtape posted again: the same post, and the song is gone', async () => {
        assert.equal((await onTape(songs[1], false)).status, 200);
        await drafted();
        assert.equal((await act(bea, beaRoot, 'publish', { doc: draft })).post, post);
        await synced();
        let now = [];
        for (let i = 0; i < 60; i++) {
            const there = (await page()).find((p) => p.doc === post);
            now = there && there.words ? JSON.parse(there.words).tracks : [];
            if (now.length === 1) break;
            await wait(500);
        }
        assert.deepEqual(
            now.map((t) => t.doc),
            [tracks[0].doc],
        );
        let gone = null;
        for (let i = 0; i < 60; i++) {
            gone = await heard(tracks[1].doc);
            if (gone !== 'OggS') break;
            await synced();
            await wait(500);
        }
        assert.notEqual(gone, 'OggS', 'the dropped song is taken down in the group');
        assert.equal(await heard(tracks[0].doc), 'OggS', 'and the one still on it plays');
    });

    it('taken down, its songs go with it', async () => {
        await act(bea, beaRoot, `docs/${post}/retract`);
        await synced();
        let left = null;
        for (let i = 0; i < 60; i++) {
            left = await heard(tracks[0].doc);
            if (left !== 'OggS' && !(await page()).some((p) => p.doc === post)) break;
            await synced();
            await wait(500);
        }
        assert.ok(!(await page()).some((p) => p.doc === post), 'the mixtape left the page');
        assert.notEqual(left, 'OggS', 'and its last song went with it');
    });
});
