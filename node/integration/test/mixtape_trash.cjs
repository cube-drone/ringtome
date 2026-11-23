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
const crypto = require('node:crypto');

const { HOST, HOST_B, HOST_C, makeFetch } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold, shareArrives } = require('./beat.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A sound nobody else has: half a second of noise as a WAV. The rig is shared, and a file some
// other persona on the node also holds is rightly kept when this one throws it away ("if that was
// the only copy") - so the sample sounds the other files upload would prove nothing here.
const noise = () => {
    const pcm = crypto.randomBytes(8000);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + pcm.length, 4);
    head.write('WAVEfmt ', 8);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); // PCM
    head.writeUInt16LE(1, 22); // mono
    head.writeUInt32LE(8000, 24);
    head.writeUInt32LE(16000, 28);
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36);
    head.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([head, pcm]);
};
const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};

(HOST_B ? describe : describe.skip)('a mixtape, in the trash', function () {
    this.timeout(600000);

    let ada, adaRoot, dee, deeRoot;
    let tapePost, tracks, loose, hashes;

    const uploaded = async (title) => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs/binary?title=${title}`, {
                method: 'POST',
                body: noise(),
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
        for (const title of ['First Song', 'Second Song']) {
            const put = await j(
                ada,
                `api/identity/${adaRoot}/taxonomies/${tape}/members/${await uploaded(title)}`,
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

        const third = await uploaded('Loose Song');
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

/*
    The same, for a mixtape posted in a group (2026-11-23): a group's files are the group's, kept
    and fetched by its own machinery, so the trash is asked there too. Bea posts a mixtape to the
    Bin Club on B; ada, a member on A, throws it away - out of her hrseAmp, its songs' bytes
    collected and not fetched again - and takes it back. And when bea takes the mixtape down, its
    files leave ada's node (Curtis: "A taken-down group document's files should be collected").
*/
(HOST_B ? describe : describe.skip)('a mixtape, in the trash, from a group', function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, group, post, tracks, hashes;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch(host ? { prefix, host } : { prefix });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(who, `api/identity/${root}/serve`, {});
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
            await synced();
            await wait(400);
        }
        return false;
    };
    const library = async () => (await ada(`api/identity/${adaRoot}/amp/library`)).json();
    const trash = (items, door = 'amp/trash') =>
        j(ada, `api/identity/${adaRoot}/${door}`, { items });

    before(async () => {
        [ada, adaRoot] = await persona('gtrashada');
        [bea, beaRoot] = await persona('gtrashbea', HOST_B);
        group = (
            await (await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Bin Club' })).json()
        ).group;
        const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
        await act(bea, beaRoot, 'join', {
            invite: token.invite,
            founder: token.founder,
            inviter: token.inviter,
            via: token.via,
        });
        await act(ada, adaRoot, 'sync');
        const tape = (
            await (
                await j(bea, `api/identity/${beaRoot}/taxonomies`, { title: 'mixtape:Club Songs' })
            ).json()
        ).taxonomy_id;
        for (const title of ['First Song', 'Second Song']) {
            const made = await (
                await bea(`api/identity/${beaRoot}/docs/binary?title=${title}`, {
                    method: 'POST',
                    body: noise(),
                    file: true,
                })
            ).json();
            for (let i = 0; i < 240; i++) {
                if ((await bea(`api/identity/${beaRoot}/docs/${made.doc_id}/body`)).status === 200)
                    break;
                await wait(500);
            }
            const put = await j(
                bea,
                `api/identity/${beaRoot}/taxonomies/${tape}/members/${made.doc_id}`,
                { member_root: beaRoot },
                'PUT',
            );
            assert.equal(put.status, 200, await put.text());
        }
        const drafted = await bea(`api/identity/${beaRoot}/amp/tapes/${tape}/draft`, {
            method: 'PUT',
        });
        assert.equal(drafted.status, 200, await drafted.clone().text());
        post = (await act(bea, beaRoot, 'publish', { doc: (await drafted.json()).doc_id })).post;
        // At ada's node: the tracklist, then each song's bytes, named by their hash.
        for (let i = 0; i < 120 && !tracks; i++) {
            await synced();
            const r = await ada(`api/groups/${group}/docs/${post}/body`);
            if (r.status === 200) tracks = (await r.json()).tracks;
            else await wait(500);
        }
        assert.equal((tracks || []).length, 2, 'the mixtape reached ada');
        hashes = [];
        for (const t of tracks) {
            let tag = '';
            for (let i = 0; i < 120 && !tag; i++) {
                const r = await ada(`api/groups/${group}/docs/${t.doc}/body`);
                if (r.status === 200) tag = (r.headers.get('etag') || '').replace(/[W/"]/g, '');
                else {
                    await synced();
                    await wait(500);
                }
            }
            assert.match(tag, /^[0-9a-f]{64}$/, `${t.title} reached ada`);
            hashes.push(tag);
        }
    });

    it("thrown away, it leaves her hrseAmp and its songs' files leave her node; undeleted, they come back", async () => {
        const before = await library();
        assert.deepEqual(
            before.tapes.map((x) => x.post),
            [post],
        );
        const r = await trash([
            { author: beaRoot, doc: post, kind: 'mixtape', title: 'Club Songs', group },
            ...tracks.map((t) => ({
                author: beaRoot,
                doc: t.doc,
                title: t.title,
                tape: post,
                group,
            })),
        ]);
        assert.equal(r.status, 200, await r.text());
        const gone = await library();
        assert.deepEqual(gone.tapes, [], "out of the group's section");
        assert.deepEqual(gone.sounds, [], 'and its songs out of her table');
        assert.deepEqual(
            gone.trash.map((x) => [x.doc, x.kind, x.title, x.songs, x.group]),
            [[post, 'mixtape', 'Club Songs', 2, group]],
        );
        assert.ok(
            (await leaves(hashes[0])) && (await leaves(hashes[1])),
            'the bytes were collected',
        );
        // And they stay gone: thrown away, they are not fetched again.
        await synced();
        await wait(1500);
        assert.ok(!(await held(hashes[0])) && !(await held(hashes[1])));

        const back = await trash([{ author: beaRoot, doc: post }], 'amp/trash/restore');
        assert.equal(back.status, 200, await back.text());
        const lib = await library();
        assert.deepEqual(lib.trash, []);
        assert.deepEqual(
            lib.tapes.map((x) => x.post),
            [post],
        );
        assert.ok((await returns(hashes[0])) && (await returns(hashes[1])), 'and came back');
    });

    it("taken down by its author, its songs' files leave the other member's node", async () => {
        await act(bea, beaRoot, `docs/${post}/retract`);
        await synced();
        assert.ok((await leaves(hashes[0])) && (await leaves(hashes[1])));
        assert.deepEqual((await library()).tapes, []);
    });
});

/*
    And for a mixtape that only a rebroadcast brought (2026-11-23): cal, on A, follows nobody but
    bea's rebroadcasts; bea, on C, rebroadcasts ada's mixtape from B. Its songs are on A's shelf
    of shared things rather than in a chain cal's node follows - and thrown away, they leave it,
    are not fetched back, and return when cal takes the mixtape out of the trash.
*/
(HOST_B && HOST_C ? describe : describe.skip)(
    'a mixtape, in the trash, that a rebroadcast brought',
    function () {
        this.timeout(600000);

        let ada, adaRoot, bea, beaRoot, cal, calRoot, post, tracks, hashes;

        const persona = async (prefix, host) => {
            const who = await makeUserFetch(host ? { prefix, host } : { prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await j(who, `api/identity/${root}/serve`, {});
            return [who, root];
        };
        const held = async (hash) =>
            (await (await makeFetch(HOST)(`test/blob/${hash}`)).json()).present;
        const leaves = async (hash) => {
            for (let i = 0; i < 80; i++) {
                if (!(await held(hash))) return true;
                await wait(500);
            }
            return false;
        };
        const arrive = async () => {
            await shareArrives(HOST, beaRoot, adaRoot);
            await beat(HOST, 'bodies-sweep');
        };
        const returns = async (hash) => {
            for (let i = 0; i < 60; i++) {
                if (await held(hash)) return true;
                await arrive();
                await wait(400);
            }
            return false;
        };
        const library = async () => (await cal(`api/identity/${calRoot}/amp/library`)).json();
        const trash = (items, door = 'amp/trash') =>
            j(cal, `api/identity/${calRoot}/${door}`, { items });

        before(async function () {
            [cal, calRoot] = await persona('rtrashcal');
            [ada, adaRoot] = await persona('rtrashada', HOST_B);
            [bea, beaRoot] = await persona('rtrashbea', HOST_C);
            if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200)
                this.skip();
            if ((await cal(`api/id/${beaRoot}/profile?via=${await base58(bea)}`)).status !== 200)
                this.skip();

            const tape = (
                await (
                    await j(ada, `api/identity/${adaRoot}/taxonomies`, {
                        title: 'mixtape:Passed Along',
                    })
                ).json()
            ).taxonomy_id;
            for (const title of ['First Song', 'Second Song']) {
                const made = await (
                    await ada(`api/identity/${adaRoot}/docs/binary?title=${title}`, {
                        method: 'POST',
                        body: noise(),
                        file: true,
                    })
                ).json();
                for (let i = 0; i < 240; i++) {
                    if (
                        (await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/body`)).status ===
                        200
                    )
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
                const r = await j(ada, `api/identity/${adaRoot}/docs/${draft}/publish`, {});
                const said = await r.text();
                if (r.status === 200) post = JSON.parse(said).post_id;
                else await wait(500);
            }
            assert.ok(post, 'published');
            tracks = (await (await ada(`id/${adaRoot}/docs/${post}/body`)).json()).tracks;

            // Bea follows ada and rebroadcasts the mixtape; cal follows only what bea rebroadcasts.
            await j(
                bea,
                `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`,
                { value: 'max' },
                'PUT',
            );
            await beat(HOST_C, 'fold', beaRoot);
            for (let i = 0; i < 40; i++) {
                await pullAndFold(HOST_C, adaRoot);
                if ((await bea(`id/${adaRoot}/docs/${post}/body`)).status === 200) break;
                await wait(400);
            }
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
            hashes = [];
            for (const t of tracks) {
                let tag = '';
                for (let i = 0; i < 60 && !tag; i++) {
                    await arrive();
                    const r = await cal(`id/${adaRoot}/docs/${t.doc}/body`);
                    if (r.status === 200) tag = (r.headers.get('etag') || '').replace(/[W/"]/g, '');
                    else await wait(400);
                }
                assert.match(tag, /^[0-9a-f]{64}$/, `${t.title} reached cal's node`);
                hashes.push(tag.toLowerCase());
            }
        });

        it("thrown away, its songs' files leave his node and stay gone; undeleted, they come back", async () => {
            const before = await library();
            assert.deepEqual(
                before.tapes.map((x) => [x.post, x.via]),
                [[post, beaRoot]],
                `it came through bea: ${JSON.stringify(before.tapes)}`,
            );
            assert.ok((await held(hashes[0])) && (await held(hashes[1])));
            const r = await trash([
                { author: adaRoot, doc: post, kind: 'mixtape', title: 'Passed Along' },
                ...tracks.map((t) => ({ author: adaRoot, doc: t.doc, title: t.title, tape: post })),
            ]);
            assert.equal(r.status, 200, await r.text());
            const gone = await library();
            assert.deepEqual(gone.tapes, []);
            assert.deepEqual(gone.sounds, []);
            assert.ok(
                (await leaves(hashes[0])) && (await leaves(hashes[1])),
                'the bytes were collected',
            );
            // Not fetched back, whatever the shelf's own healing tries.
            await arrive();
            await arrive();
            await wait(1500);
            assert.ok(!(await held(hashes[0])) && !(await held(hashes[1])), 'and stay gone');

            const back = await trash([{ author: adaRoot, doc: post }], 'amp/trash/restore');
            assert.equal(back.status, 200, await back.text());
            assert.deepEqual(
                (await library()).tapes.map((x) => x.post),
                [post],
            );
            assert.ok((await returns(hashes[0])) && (await returns(hashes[1])), 'and came back');
        });
    },
);
