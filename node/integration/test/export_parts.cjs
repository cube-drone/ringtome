/*
    An export in parts, and a music library's way out and back in (plans/EXPORT.md; Curtis,
    2026-11-23). The export page offers four ticks - public posts, private documents, audio,
    images - and the zip holds only what was ticked. A mixtape is a list in the lists file, as it
    was, and now also a playlist any player reads (`playlists/<name>.m3u8`). An audio-only zip,
    imported into another persona, brings the songs with what they say of themselves and the
    mixtape with its songs - and the playlist is nothing the import complains of.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { sql } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (f) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sample_media', f));

describe('exports: in parts, and mixtapes as playlists', function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, admin, work, song, zip;

    const uploaded = async (who, root, title, body) => {
        const made = await (
            await who(`api/identity/${root}/docs/binary?title=${title}`, {
                method: 'POST',
                body,
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
    const exported = async (parts, name) => {
        const started = await j(ada, `api/identity/${adaRoot}/export`, parts);
        assert.equal(started.status, 200, await started.clone().text());
        for (let i = 0; i < 400; i++) {
            const r = await (await ada(`api/identity/${adaRoot}/export`)).json();
            if (r.status === 'ready') break;
            assert.notEqual(r.status, 'failed', `the export failed: ${r.error}`);
            await wait(250);
        }
        const res = await ada(`api/identity/${adaRoot}/export/download`);
        assert.equal(res.status, 200);
        const at = path.join(work, name);
        fs.writeFileSync(at, Buffer.from(await res.arrayBuffer()));
        return at;
    };
    const listing = (z) => execFileSync('unzip', ['-Z1', z], { encoding: 'utf8' }).split('\n');
    const read = (z, name) => execFileSync('unzip', ['-p', z, name], { encoding: 'utf8' });

    before(async () => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ringtome-export-parts-'));
        admin = await makeUserFetch({ prefix: 'partsadmin' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
        );
        ada = await makeUserFetch({ prefix: 'partsada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        bea = await makeUserFetch({ prefix: 'partsbea' });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: 'POST' });

        const note = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'A brown horse',
                    body: 'The horse is **brown**.',
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${note}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        await uploaded(ada, adaRoot, 'spud', makePng(24, 24));
        song = await uploaded(ada, adaRoot, 'memo', sample('buck-audio.ogg'));
        for (const [field, value] of [
            ['track', 'Road Song'],
            ['artist', 'The Bucks'],
        ]) {
            const put = await j(
                ada,
                `api/identity/${adaRoot}/docs/${song}/annotations/fields/${field}`,
                { value },
                'PUT',
            );
            assert.equal(put.status, 200, await put.text());
        }
        const tape = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'mixtape:Road Songs' })
            ).json()
        ).taxonomy_id;
        const on = await j(
            ada,
            `api/identity/${adaRoot}/taxonomies/${tape}/members/${song}`,
            { member_root: adaRoot },
            'PUT',
        );
        assert.equal(on.status, 200, await on.text());
        // A song of somebody else's on it too: not hers to export.
        await j(
            ada,
            `api/identity/${adaRoot}/taxonomies/${tape}/members/${'ab'.repeat(16)}`,
            { member_root: beaRoot },
            'PUT',
        );
    });

    after(async () => {
        await j(admin, 'api/admin/import-policy', { allowed: false }, 'PUT');
    });

    it('nothing ticked is nothing to export', async () => {
        const res = await j(ada, `api/identity/${adaRoot}/export`, {
            public: false,
            private: false,
            audio: false,
            images: false,
        });
        assert.equal(res.status, 400, await res.text());
    });

    it('audio alone: the songs, their details and the lists - no notes, posts, pictures or ledger', async () => {
        zip = await exported(
            { public: false, private: false, audio: true, images: false },
            'audio.zip',
        );
        const names = listing(zip).filter(Boolean);
        assert.ok(
            names.some((n) => n.endsWith('.opus')) && names.some((n) => n.endsWith('.opus.yml')),
            names.join(', '),
        );
        assert.ok(names.includes('private/taxonomies.yml'), 'the lists name the songs');
        assert.ok(names.includes('README.txt') && names.includes('manifest.json'));
        for (const gone of ['.mq', '.md', '.avif', 'contacts.yml', 'bank.yml', 'profile.yml'])
            assert.ok(!names.some((n) => n.endsWith(gone)), `no ${gone}: ${names.join(', ')}`);
        assert.ok(!names.some((n) => n.startsWith('public/')), 'nothing public');
        assert.match(read(zip, 'README.txt'), /\[x\] audio/);
        assert.match(read(zip, 'README.txt'), /\[ \] private documents/);
    });

    it('a mixtape is also a playlist any player reads, naming the files beside it', () => {
        const names = listing(zip);
        assert.ok(names.includes('playlists/Road Songs.m3u8'), names.join(', '));
        const lines = read(zip, 'playlists/Road Songs.m3u8').split('\n').filter(Boolean);
        assert.equal(lines[0], '#EXTM3U');
        assert.equal(lines[1], '#PLAYLIST:Road Songs');
        assert.match(lines[2], /^#EXTINF:\d+,The Bucks - Road Song$/);
        assert.match(lines[3], /^\.\.\/private\/.+\.opus$/);
        assert.ok(
            names.includes(lines[3].slice(3)),
            `the file it names is in the zip: ${lines[3]}`,
        );
        assert.equal(
            lines[4],
            `# not in this export: ${beaRoot}/${'ab'.repeat(16)}`,
            "somebody else's song is a comment",
        );
    });

    it('pictures alone, and everything by default', async () => {
        const pictures = listing(
            await exported({ public: false, private: false, audio: false, images: true }, 'p.zip'),
        ).filter(Boolean);
        assert.ok(
            pictures.some((n) => n.endsWith('.avif')),
            pictures.join(', '),
        );
        assert.ok(!pictures.some((n) => n.endsWith('.opus') || n.startsWith('playlists/')));
        const whole = listing(await exported({}, 'whole.zip')).filter(Boolean);
        for (const ext of ['.opus', '.avif', '.mq', 'contacts.yml', '.m3u8'])
            assert.ok(
                whole.some((n) => n.endsWith(ext)),
                `${ext} in the whole`,
            );
        assert.ok(whole.some((n) => n.startsWith('public/')));
    });

    it('the audio zip, imported elsewhere, brings the song with what it says and the mixtape with it', async () => {
        await j(admin, 'api/admin/import-policy', { allowed: true }, 'PUT');
        const res = await bea(`api/identity/${beaRoot}/import`, {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: fs.readFileSync(zip),
        });
        assert.equal(res.status, 200, await res.clone().text());
        let log = null;
        for (let i = 0; i < 480 && !log; i++) {
            const r = await (await bea(`api/identity/${beaRoot}/import`)).json();
            assert.notEqual(
                r.status,
                'failed',
                `the import failed: ${r.error}\n${r.log.join('\n')}`,
            );
            if (r.status === 'done') log = r.log;
            else await wait(250);
        }
        assert.ok(log, 'the import finished');
        assert.ok(
            !log.some((l) => /m3u8/i.test(l)),
            `the playlist is no complaint: ${log.join(' | ')}`,
        );
        const docs = (await (await bea(`api/identity/${beaRoot}/docs`)).json()).docs;
        const hers = docs.find((d) => d.format === 'opus');
        assert.ok(hers, `a sound arrived: ${JSON.stringify(docs.map((d) => [d.title, d.format]))}`);
        assert.equal(hers.fields.track, 'Road Song');
        assert.equal(hers.fields.artist, 'The Bucks');
        const lists = await (await bea(`api/identity/${beaRoot}/taxonomies`)).json();
        const tape = (lists.taxonomies || lists).find((x) => x.title === 'mixtape:Road Songs');
        assert.ok(tape, `the mixtape came with it: ${JSON.stringify(lists).slice(0, 300)}`);
        const tree = await (
            await bea(`api/identity/${beaRoot}/taxonomies/${tape.taxonomy_id}`)
        ).json();
        assert.ok(
            (tree.members || []).some((m) => m.doc_id === hers.doc_id),
            `and the song is on it: ${JSON.stringify(tree.members)}`,
        );
    });
});
