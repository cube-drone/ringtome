/*
    Exports (plans/EXPORT.md): a persona as one zip. A note in a notebook's section lands in its
    folder three ways (.mq with its details in a :::meta line, .md, .yml.md); a plain note in
    unfiled as .txt and .yml.txt; a trusted-only post the persona published comes out OPENED under
    public/; the profile, contacts and ledger are files of their own; and no sealing key is
    anywhere in it (ruling 3). A second export replaces the first, and nobody else may ask.
*/
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { makeUserFetch } = require('./helpers.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });

describe('exports: a persona as one zip', function () {
    this.timeout(120000);

    let ada, adaRoot, horse, plain, doodle, zip;

    const ready = async () => {
        for (let i = 0; i < 200; i++) {
            const r = await (await ada(`api/identity/${adaRoot}/export`)).json();
            if (r.status === 'ready') return r;
            assert.notEqual(r.status, 'failed', `the export failed: ${r.error}`);
            await new Promise((res) => setTimeout(res, 250));
        }
        throw new Error('the export never finished');
    };
    const listing = () => execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n');
    const read = (name) => execFileSync('unzip', ['-p', zip, name], { encoding: 'utf8' });

    before(async () => {
        ada = await makeUserFetch({ prefix: 'exportada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        horse = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'A brown horse',
                    body: 'The horse is **brown**.',
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        plain = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'shopping',
                    body: 'oats, hay',
                })
            ).json()
        ).doc_id;
        await ada(`api/identity/${adaRoot}/docs/${horse}/buckets/stable`, { method: 'PUT' });
        doodle = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'doodle',
                    body: JSON.stringify({
                        strokes: [
                            {
                                id: '0000000000000001',
                                t: 1,
                                tool: 'brush',
                                color: '#000000',
                                size: 20,
                                points: [100, 100, 600, 400],
                            },
                        ],
                    }),
                    format: 'drawing',
                })
            ).json()
        ).doc_id;
        await ada(`api/identity/${adaRoot}/docs/${horse}/annotations/tags/brown`, {
            method: 'PUT',
        });
        // The notebook's tree: a section, the note in it.
        const tree = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'wiki:stable' })
            ).json()
        ).taxonomy_id;
        const barn = (
            await (await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: 'barn' })).json()
        ).taxonomy_id;
        await j(ada, `api/identity/${adaRoot}/taxonomies/${tree}/members/${barn}`, {}, 'PUT');
        await j(ada, `api/identity/${adaRoot}/taxonomies/${barn}/members/${horse}`, {}, 'PUT');
        // Published for trusted readers only: sealed on the network, opened in the export.
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${horse}/publish`, {
            trusted_only: true,
        });
        assert.equal(pub.status, 200, await pub.clone().text());
    });

    it('makes the zip in the background, and hands it over when it is ready', async () => {
        const started = await (await j(ada, `api/identity/${adaRoot}/export`, {})).json();
        assert.ok(['queued', 'running', 'ready'].includes(started.status), started.status);
        const done = await ready();
        assert.ok(done.bytes > 0 && done.made_ms > 0, JSON.stringify(done));
        const res = await ada(`api/identity/${adaRoot}/export/download`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/zip');
        assert.match(
            res.headers.get('content-disposition'),
            new RegExp(`filename="hdt2-([a-z0-9-]+-)?${adaRoot.slice(0, 8)}\\.zip"`),
        );
        zip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ringtome-export-')), 'export.zip');
        fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        assert.ok(listing().includes('README.txt'));
    });

    it('files a notebook note under its notebook and section, in every rendering', () => {
        const stem = `private/buckets/stable/barn/A brown horse--${horse.slice(0, 8)}`;
        const names = listing();
        for (const ext of ['.mq', '.md', '.yml.md']) {
            assert.ok(names.includes(stem + ext), `${stem}${ext} in ${names.join(', ')}`);
        }
        const mq = read(`${stem}.mq`);
        assert.match(mq, /^:::meta /, 'its details lead, as a :::meta directive');
        assert.match(mq, /title="A brown horse"/);
        assert.match(mq, /tags=brown/);
        assert.match(mq, /created=\d{4}-\d\d-\d\dT/);
        assert.match(mq, /The horse is \*\*brown\*\*\./);
        assert.doesNotMatch(read(`${stem}.md`), /:::meta|"title"/, 'the .md is words only');
        assert.match(read(`${stem}.yml.md`), /^---\n"id": "/);
    });

    it('writes a plain note as .txt and .yml.txt, in unfiled', () => {
        const stem = `private/unfiled/shopping--${plain.slice(0, 8)}`;
        assert.equal(read(`${stem}.txt`), 'oats, hay');
        assert.match(read(`${stem}.yml.txt`), /^---\n[\s\S]*---\noats, hay$/);
    });

    it('paints a drawing beside its strokes, on the node (drawing_paint.rs)', () => {
        const stem = `private/unfiled/doodle--${doodle.slice(0, 8)}`;
        assert.match(read(`${stem}.horsedrawing`), /"tool":"brush"/);
        const png = execFileSync('unzip', ['-p', zip, `${stem}.horsedrawing.png`]);
        assert.equal(png.subarray(1, 4).toString(), 'PNG');
        // IHDR: twice the drawing's 800 x 600, the browser download's own backing.
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1600, 1200]);
    });

    it('opens the trusted-only post it published, under public/', () => {
        const post = listing().find(
            (n) => n.startsWith('public/buckets/stable/A brown horse--') && n.endsWith('.md'),
        );
        assert.ok(post, `the post in ${listing().join(', ')}`);
        assert.match(read(post), /brown/, 'sealed on the network, opened in the export');
    });

    it('carries the profile, contacts and ledger - and no key', () => {
        const names = listing();
        for (const name of ['public/profile.yml', 'private/contacts.yml', 'private/bank.yml']) {
            assert.ok(names.includes(name), name);
        }
        const everything = execFileSync('unzip', ['-p', zip], { encoding: 'utf8' });
        assert.doesNotMatch(everything, /trusted_key/, 'no sealing key (ruling 3)');
    });

    it('lists every file in its manifest, by hash - and each document by id and version', () => {
        const manifest = JSON.parse(read('manifest.json'));
        assert.equal(manifest.format, 'hdt2-export');
        assert.equal(manifest.persona, adaRoot);
        const listed = new Map(manifest.files.map((f) => [f.path, f]));
        for (const name of listing().filter((n) => n && n !== 'manifest.json')) {
            const row = listed.get(name);
            assert.ok(row, `${name} is in the manifest`);
            const bytes = execFileSync('unzip', ['-p', zip, name]);
            assert.equal(row.sha256, crypto.createHash('sha256').update(bytes).digest('hex'), name);
        }
        const mq = manifest.files.find(
            (f) => f.path.endsWith('.mq') && f.path.startsWith('private/'),
        );
        assert.equal(mq.id, horse);
        assert.match(mq.head, /^[0-9a-f]{64}$/);
        assert.match(
            read(mq.path),
            new RegExp(`head=${mq.head}`),
            'and the file says which version',
        );
    });

    // An export the node was making when it stopped (2026-10-09: a large account's came back to
    // nothing, and the page could only offer to start again): its state is written down as it
    // goes, so afterwards the page hears that it was interrupted, and how far it got.
    it('an export the server stopped during is reported interrupted, with how far it got', async () => {
        const stray = await makeUserFetch({ prefix: 'exportstray' });
        const strayRoot = (await (await stray('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        // What a node that stopped mid-export leaves behind: the state, and no job running.
        const dir = path.resolve(__dirname, '../../../data/test/exports');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, `${strayRoot}.json`),
            JSON.stringify({ status: 'running', done: 5, total: 10, started_ms: 1 }),
        );
        const r = await (await stray(`api/identity/${strayRoot}/export`)).json();
        assert.equal(r.status, 'interrupted');
        assert.deepEqual([r.done, r.total], [5, 10]);
        assert.match(r.error, /stopped/);
        // Asking again starts afresh, and finishes.
        await j(stray, `api/identity/${strayRoot}/export`, {});
        for (let i = 0; i < 200; i++) {
            const now = await (await stray(`api/identity/${strayRoot}/export`)).json();
            if (now.status === 'ready') return;
            assert.ok(['queued', 'running'].includes(now.status), JSON.stringify(now));
            await new Promise((res) => setTimeout(res, 250));
        }
        throw new Error('never finished');
    });

    it('nobody else may ask for it', async () => {
        const eve = await makeUserFetch({ prefix: 'exporteve' });
        assert.notEqual((await eve(`api/identity/${adaRoot}/export`)).status, 200);
        assert.notEqual((await eve(`api/identity/${adaRoot}/export/download`)).status, 200);
    });

    it('a second export replaces the first', async () => {
        const first = await (await ada(`api/identity/${adaRoot}/export`)).json();
        await new Promise((res) => setTimeout(res, 1100)); // a new file, a new mtime
        const again = await (await j(ada, `api/identity/${adaRoot}/export`, {})).json();
        assert.notEqual(again.status, 'none');
        const done = await ready();
        assert.ok(done.made_ms > first.made_ms, 'a new zip, not the old one');
    });
});
