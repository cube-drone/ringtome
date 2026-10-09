/*
    Imports (plans/EXPORT.md, Import): additive only (Curtis, 2026-10-09). The zip a persona
    exported, imported back into it, adds nothing - every document "skipped: It already exists!" -
    even one edited in the zip, whose words stay as they were. Imported into a fresh persona, the
    same zip creates every note under its own id with its tags and notebook, republishes the post,
    re-applies the contacts, and takes a Markdown file written somewhere else as a new note; and
    importing it there a second time adds nothing more.
*/
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { makeUserFetch } = require('./helpers.cjs');
const { sql } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });

describe('imports: additive only', function () {
    this.timeout(180000);

    let ada, adaRoot, bea, beaRoot, friendRoot, horse, post, work, admin;

    // The integration nodes are servers, where imports wait on the administrator (import.rs).
    const policy = (allowed) =>
        j(admin, 'api/admin/import-policy', { allowed }, 'PUT').then((r) => {
            assert.equal(r.status, 200);
        });

    const exported = async () => {
        await j(ada, `api/identity/${adaRoot}/export`, {});
        for (let i = 0; i < 200; i++) {
            const r = await (await ada(`api/identity/${adaRoot}/export`)).json();
            if (r.status === 'ready') break;
            await new Promise((res) => setTimeout(res, 250));
        }
        const res = await ada(`api/identity/${adaRoot}/export/download`);
        assert.equal(res.status, 200);
        const zip = path.join(work, 'export.zip');
        fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        return zip;
    };

    const imported = async (who, root, zip) => {
        const res = await who(`api/identity/${root}/import`, {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: fs.readFileSync(zip),
        });
        assert.equal(res.status, 200, await res.clone().text());
        for (let i = 0; i < 400; i++) {
            const r = await (await who(`api/identity/${root}/import`)).json();
            if (r.status === 'done') return r.log;
            assert.notEqual(
                r.status,
                'failed',
                `the import failed: ${r.error}\n${r.log.join('\n')}`,
            );
            await new Promise((res) => setTimeout(res, 250));
        }
        throw new Error('the import never finished');
    };

    const docs = async (who, root) => (await (await who(`api/identity/${root}/docs`)).json()).docs;
    const posts = async (who, root) =>
        (await (await who(`api/id/${root}/profile`)).json()).posts || [];

    before(async () => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ringtome-import-'));
        admin = await makeUserFetch({ prefix: 'importadmin' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
        );
        ada = await makeUserFetch({ prefix: 'importada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        const friend = await makeUserFetch({ prefix: 'importfriend' });
        friendRoot = (await (await friend('api/identity', { method: 'POST' })).json()).root_pubkey;
        bea = await makeUserFetch({ prefix: 'importbea' });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: 'POST' });

        horse = (
            await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'A brown horse',
                    body: 'The horse is **brown**.',
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        await ada(`api/identity/${adaRoot}/docs/${horse}/buckets/stable`, { method: 'PUT' });
        await ada(`api/identity/${adaRoot}/docs/${horse}/annotations/tags/brown`, {
            method: 'PUT',
        });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${horse}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        post = (await pub.json()).post_id;
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${friendRoot}/interest`,
            { value: 'high' },
            'PUT',
        );
    });

    after(() => policy(false));

    it('a server takes no imports until its administrator allows them', async () => {
        await policy(false);
        const zip = await exported();
        const report = await (await ada(`api/identity/${adaRoot}/import`)).json();
        assert.equal(report.allowed, false);
        const res = await ada(`api/identity/${adaRoot}/import`, {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: fs.readFileSync(zip),
        });
        assert.equal(res.status, 403);
        await policy(true);
        assert.equal((await (await ada(`api/identity/${adaRoot}/import`)).json()).allowed, true);
    });

    it('imported back into the persona that made it, adds nothing', async () => {
        const zip = await exported();
        const before = (await docs(ada, adaRoot)).length;
        const log = await imported(ada, adaRoot, zip);
        assert.ok(
            log.includes('Document A brown horse skipped: It already exists!'),
            log.join('\n'),
        );
        assert.ok(
            log.some((l) => /^Post A brown horse skipped/.test(l)),
            log.join('\n'),
        );
        assert.equal((await docs(ada, adaRoot)).length, before, 'not one document more');
        assert.equal((await posts(ada, adaRoot)).length, 1, 'and no second post');
    });

    it('a note edited in the zip is still skipped, and its words stay as they were', async () => {
        const zip = await exported();
        const dir = path.join(work, 'edited');
        fs.rmSync(dir, { recursive: true, force: true });
        execFileSync('unzip', ['-q', zip, '-d', dir]);
        const mq = execFileSync('find', [dir, '-path', '*private*', '-name', '*.mq'], {
            encoding: 'utf8',
        }).trim();
        fs.writeFileSync(mq, fs.readFileSync(mq, 'utf8').replace('brown**', 'purple**'));
        const edited = path.join(work, 'edited.zip');
        fs.rmSync(edited, { force: true });
        execFileSync('zip', ['-qr', edited, '.'], { cwd: dir });
        const log = await imported(ada, adaRoot, edited);
        assert.ok(log.includes('Document A brown horse skipped: It already exists!'));
        const body = await (await ada(`api/identity/${adaRoot}/docs/${horse}/body`)).text();
        assert.match(body, /brown/);
        assert.doesNotMatch(body, /purple/, 'additive only: an edit never lands');
    });

    it('into a fresh persona: notes keep their ids, tags and notebook; the post is said again; contacts come back', async () => {
        const zip = await exported();
        // A note written somewhere else, dropped in: no id, so a new document in its folder's notebook.
        const dir = path.join(work, 'fresh');
        fs.rmSync(dir, { recursive: true, force: true });
        execFileSync('unzip', ['-q', zip, '-d', dir]);
        fs.mkdirSync(path.join(dir, 'private/buckets/stable'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'private/buckets/stable/from obsidian.md'),
            '---\ntitle: From Obsidian\ntags: [imported]\n---\n# Hello\n\nWritten elsewhere.\n',
        );
        const fresh = path.join(work, 'fresh.zip');
        fs.rmSync(fresh, { force: true });
        execFileSync('zip', ['-qr', fresh, '.'], { cwd: dir });

        const log = await imported(bea, beaRoot, fresh);
        assert.ok(log.includes('Document A brown horse added.'), log.join('\n'));
        assert.ok(log.includes('Post A brown horse republished.'), log.join('\n'));
        const mine = await docs(bea, beaRoot);
        const note = mine.find((d) => d.doc_id === horse);
        assert.ok(note, `the note under its own id: ${JSON.stringify(mine.map((d) => d.title))}`);
        assert.deepEqual(note.buckets, ['stable']);
        const tags = await (await bea(`api/identity/${beaRoot}/docs/${horse}/annotations`)).json();
        assert.ok(JSON.stringify(tags).includes('brown'), JSON.stringify(tags));
        assert.ok(
            mine.some((d) => d.title === 'From Obsidian'),
            'the file with no id is a new note',
        );
        const theirPosts = await posts(bea, beaRoot);
        assert.equal(theirPosts.length, 1, 'the post, republished as theirs');
        const contact = await (
            await bea(`api/identity/${beaRoot}/private/kv/contact:${friendRoot}`)
        ).json();
        assert.ok(
            (contact.values || []).some((v) => v.key === 'interest' && v.value === 'high'),
            JSON.stringify(contact),
        );
    });

    it('imported into that persona again, adds nothing more', async () => {
        const fresh = path.join(work, 'fresh.zip');
        const before = (await docs(bea, beaRoot)).length;
        const log = await imported(bea, beaRoot, fresh);
        assert.ok(
            log.includes('Document A brown horse skipped: It already exists!'),
            log.join('\n'),
        );
        assert.ok(
            log.some((l) => /^Post A brown horse skipped/.test(l)),
            log.join('\n'),
        );
        assert.equal((await docs(bea, beaRoot)).length, before);
        assert.equal((await posts(bea, beaRoot)).length, 1, 'still the one post');
    });

    it('refuses what no document may be: too large, or a drawing that is no drawing', async () => {
        const dir = path.join(work, 'odd');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, 'private/unfiled'), { recursive: true });
        // The test nodes hold a document to 256 KiB (RINGTOME_MAX_DOCUMENT_BYTES).
        fs.writeFileSync(path.join(dir, 'private/unfiled/huge.txt'), 'x'.repeat(300 * 1024));
        fs.writeFileSync(path.join(dir, 'private/unfiled/broken.horsedrawing'), 'not strokes');
        const odd = path.join(work, 'odd.zip');
        fs.rmSync(odd, { force: true });
        execFileSync('zip', ['-qr', odd, '.'], { cwd: dir });
        const before = (await docs(bea, beaRoot)).length;
        const log = await imported(bea, beaRoot, odd);
        assert.ok(
            log.some((l) => /^Document huge skipped: it's larger/.test(l)),
            log.join('\n'),
        );
        assert.ok(
            log.includes("Document broken skipped: it isn't a drawing this app can read."),
            log.join('\n'),
        );
        assert.equal((await docs(bea, beaRoot)).length, before);
    });

    it('a post unpublished since the export stays unpublished', async () => {
        const zip = await exported();
        const gone = await ada(`api/identity/${adaRoot}/posts/${post}`, { method: 'DELETE' });
        assert.ok(gone.status < 300, await gone.text());
        assert.equal((await posts(ada, adaRoot)).length, 0);
        const log = await imported(ada, adaRoot, zip);
        assert.ok(
            log.some((l) => /^Post A brown horse skipped/.test(l)),
            log.join('\n'),
        );
        assert.equal((await posts(ada, adaRoot)).length, 0, 'the import does not say it again');
    });

    it("a zip can't publish a note the persona already had", async () => {
        // A post in somebody's zip naming one of bea's own private notes as its source: an import
        // publishes only notes it made itself, never one that was already here.
        const secret = (
            await (
                await j(bea, `api/identity/${beaRoot}/docs`, { title: 'diary', body: 'private' })
            ).json()
        ).doc_id;
        const before = (await posts(bea, beaRoot)).length;
        const dir = path.join(work, 'bait');
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, 'public/unfiled'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'public/unfiled/bait.yml.md'),
            `---\n"id": "${'ab'.repeat(16)}"\n"title": "bait"\n"published_from": "${secret}"\n---\nbait\n`,
        );
        const bait = path.join(work, 'bait.zip');
        fs.rmSync(bait, { force: true });
        execFileSync('zip', ['-qr', bait, '.'], { cwd: dir });
        const log = await imported(bea, beaRoot, bait);
        assert.ok(log.includes('Post bait skipped: It already exists!'), log.join('\n'));
        assert.equal((await posts(bea, beaRoot)).length, before, 'the diary stays private');
    });

    it('nobody else may import into a persona', async () => {
        const eve = await makeUserFetch({ prefix: 'importeve' });
        const res = await eve(`api/identity/${adaRoot}/import`, {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: Buffer.from('PK'),
        });
        assert.notEqual(res.status, 200);
    });
});
