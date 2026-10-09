/*
    Exports (plans/EXPORT.md): a persona as one zip. A note in a notebook's section lands in its
    folder three ways (.mq with its details in a :::meta line, .md, .yml.md); a plain note in
    unfiled as .txt and .yml.txt; a trusted-only post the persona published comes out OPENED under
    public/; the profile, contacts and ledger are files of their own; and no sealing key is
    anywhere in it (ruling 3). A second export replaces the first, and nobody else may ask.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { makeUserFetch } = require('./helpers.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });

describe('exports: a persona as one zip', function () {
    this.timeout(120000);

    let ada, adaRoot, horse, plain, zip;

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
