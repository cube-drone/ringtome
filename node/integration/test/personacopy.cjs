/*
    Copy to another persona (Curtis, 2026-11-23): one of a persona's own pictures, sounds or videos,
    copied into another persona of the same account, from hrseFiles - its bytes as they were
    stored (never crushed again), its fields, tags and notebooks with it. Copying it again names the
    copy already made, so a long run that stopped picks up where it was; a copy deleted since is
    made again. Only the account's own personas, never this one, and only files.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { makeUserFetch } = require('./helpers.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));

describe('copy to another persona', function () {
    this.timeout(180000);

    let me, cube, curtis, song, note, copy;

    const docs = async (root) => (await (await me(`api/identity/${root}/docs`)).json()).docs;
    const copyTo = (from, doc, to, who = me) =>
        who(`api/identity/${from}/docs/${doc}/copy-to/${to}`, { method: 'POST' });
    const bytes = async (root, doc) =>
        Buffer.from(await (await me(`api/identity/${root}/docs/${doc}/body`)).arrayBuffer());

    before(async () => {
        me = await makeUserFetch({ prefix: 'pcopy' });
        cube = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
        curtis = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
        for (const r of [cube, curtis]) await me(`api/identity/${r}/serve`, { method: 'POST' });
        const made = await (
            await me(`api/identity/${cube}/docs/binary?title=memo`, {
                method: 'POST',
                body: sample('buck-audio.ogg'),
                file: true,
            })
        ).json();
        for (let i = 0; i < 240; i++) {
            if ((await me(`api/identity/${cube}/docs/${made.doc_id}/body`)).status === 200) break;
            await wait(500);
        }
        song = made.doc_id;
        for (const [field, value] of [
            ['track', 'Road Song'],
            ['artist', 'The Bucks'],
        ]) {
            const r = await j(
                me,
                `api/identity/${cube}/docs/${song}/annotations/fields/${field}`,
                { value },
                'PUT',
            );
            assert.equal(r.status, 200, await r.text());
        }
        await me(`api/identity/${cube}/docs/${song}/annotations/tags/driving`, { method: 'PUT' });
        await j(me, `api/identity/${cube}/buckets`, { name: 'road trips', app: 'amp' });
        await me(`api/identity/${cube}/docs/${song}/buckets/road%20trips`, { method: 'PUT' });
        note = (
            await (
                await j(me, `api/identity/${cube}/docs`, {
                    title: 'a note',
                    body: 'words',
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
    });

    it('copies a sound with its bytes, fields, tags and notebook', async () => {
        const r = await copyTo(cube, song, curtis);
        assert.equal(r.status, 200, await r.clone().text());
        const said = await r.json();
        assert.equal(said.already, false);
        copy = said.doc_id;
        assert.notEqual(copy, song, 'a document of its own');
        const theirs = (await docs(curtis)).find((d) => d.doc_id === copy);
        assert.ok(theirs, 'in the other persona');
        assert.equal(theirs.format, 'opus');
        assert.equal(theirs.fields.track, 'Road Song');
        assert.equal(theirs.fields.artist, 'The Bucks');
        assert.ok((theirs.tags || []).includes('driving'), JSON.stringify(theirs.tags));
        assert.ok((theirs.buckets || []).includes('road trips'), JSON.stringify(theirs.buckets));
        assert.ok(
            (await bytes(curtis, copy)).equals(await bytes(cube, song)),
            'the same bytes, never crushed again',
        );
        const roster = await (await me(`api/identity/${curtis}/buckets`)).json();
        const notebook = (roster.buckets || roster).find((b) => b.name === 'road trips');
        assert.equal(notebook && notebook.app, 'amp', 'the notebook made as the first has it');
    });

    it('copied again, names the copy already made; deleted, makes it again', async () => {
        const again = await (await copyTo(cube, song, curtis)).json();
        assert.deepEqual(again, { doc_id: copy, already: true });
        assert.equal((await docs(curtis)).filter((d) => d.format === 'opus').length, 1);
        await me(`api/identity/${curtis}/docs/${copy}`, { method: 'DELETE' });
        const fresh = await (await copyTo(cube, song, curtis)).json();
        assert.equal(fresh.already, false);
        assert.notEqual(fresh.doc_id, copy);
    });

    it('refuses this persona, a note, and a persona of another account', async () => {
        assert.equal((await copyTo(cube, song, cube)).status, 400);
        assert.equal((await copyTo(cube, note, curtis)).status, 400);
        const stranger = await makeUserFetch({ prefix: 'pcopystranger' });
        const theirs = (await (await stranger('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        assert.ok(
            [403, 404].includes((await copyTo(cube, song, theirs)).status),
            'not mine to copy into',
        );
        assert.ok(
            [403, 404].includes((await copyTo(cube, song, theirs, stranger)).status),
            'nor theirs to copy from',
        );
    });
});
