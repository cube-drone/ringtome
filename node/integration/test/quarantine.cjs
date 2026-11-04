/*
    Quarantine (plans/SCANNING.md, step 1; Curtis, 2026-11-02): an operator seals a picture their
    node holds, by its address or its file's hash. Nothing on the node serves it again - not the
    web, not a 304 for a copy someone kept, not another node asking - and the file stays until it
    is released, with a record of who did what and when.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, HOST_B, sql, makeFetch } = require('./fetch.cjs');
const { makeUserFetch, makePng } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('quarantine', function () {
    this.timeout(120000);

    let admin, ada, root, twin, post, far;
    const anon = makeFetch();

    before(async () => {
        admin = await makeUserFetch({ prefix: 'quaradmin' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
            HOST,
        );
        ada = await makeUserFetch({ prefix: 'quarada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
        const pic = (
            await (
                await ada(`api/identity/${root}/docs/binary?title=a horse`, {
                    method: 'POST',
                    // A size no other claim uploads: crushes are deterministic, so a picture
                    // another claim put on bravo would be bravo's own copy, served from its disk.
                    body: makePng(53, 47),
                    file: true,
                })
            ).json()
        ).doc_id;
        for (let i = 0; i < 60; i++) {
            if ((await ada(`api/identity/${root}/docs/${pic}/body`)).status === 200) break;
            await wait(250);
        }
        const d = await (
            await j(ada, `api/identity/${root}/docs`, {
                title: 'a picture',
                body: `look\n\n![a horse](/api/identity/${root}/docs/${pic}/body/a-horse.png)\n`,
                format: 'marquee',
            })
        ).json();
        const pub = await j(ada, `api/identity/${root}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        post = (await pub.json()).post_id;
        const head = await (await ada(`api/id/${root}/posts/${post}`)).json();
        twin = (head.refs || [])[0];
        assert.ok(twin, 'the post minted a public picture');
    });

    const body = () => `id/${root}/docs/${twin}/body`;

    it('is for administrators only', async function () {
        const r = await j(ada, 'api/admin/quarantine', {
            address: `/ringtome/user/${root}/doc/${twin}/body`,
        });
        assert.ok(r.status === 401 || r.status === 403, `got ${r.status}`);
        assert.equal((await anon(body())).status, 200, 'and changed nothing');
    });

    it('seals a picture by its address: gone from the web, even for a kept copy', async function () {
        const before = await anon(body());
        assert.equal(before.status, 200);
        const etag = before.headers.get('etag');

        const r = await j(admin, 'api/admin/quarantine', {
            address: `https://example.org/ringtome/user/${root}/doc/${twin}/thumb`,
            why: 'reported, and it is what they said',
        });
        assert.equal(r.status, 200, await r.clone().text());
        const rows = (await r.json()).rows;
        assert.ok(rows.length >= 1);
        assert.ok(
            rows.every((row) => row.author === root && row.doc_id === twin && !row.released_ms),
        );
        assert.ok(
            rows.some((row) => `"${row.hash}"` === etag),
            "the picture's own file is sealed",
        );
        assert.ok(
            rows.every((row) => row.held),
            'and kept',
        );

        assert.equal((await anon(body())).status, 404);
        assert.equal(
            (await anon(body(), { headers: { 'If-None-Match': etag } })).status,
            404,
            'no 304 vouches for a copy someone kept',
        );
        assert.equal((await ada(body())).status, 404, 'not even for its author');
    });

    (HOST_B ? it : it.skip)('is not handed to another node that asks', async function () {
        far = await makeUserFetch({ prefix: 'quarfar', host: HOST_B });
        await (await far('api/identity', { method: 'POST' })).json();
        // The control: the post's own words travel the same road, unsealed.
        let words = 0;
        for (let i = 0; i < 40 && words !== 200; i++) {
            words = (await far(`id/${root}/docs/${post}/body`)).status;
            assert.notEqual((await far(body())).status, 200, 'the far node never got the picture');
            if (words !== 200) await wait(500);
        }
        assert.equal(words, 200, "the post's words reached the far node");
        assert.notEqual((await far(body())).status, 200);
    });

    it('releases, and keeps the record', async function () {
        const rows = (await (await admin('api/admin/quarantine')).json()).rows.filter(
            (row) => row.doc_id === twin,
        );
        for (const row of rows) {
            const r = await admin(`api/admin/quarantine/${row.hash}/release`, { method: 'POST' });
            assert.equal(r.status, 200, await r.clone().text());
        }
        assert.equal((await anon(body())).status, 200, 'served again');
        const after = (await (await admin('api/admin/quarantine')).json()).rows.filter(
            (row) => row.doc_id === twin,
        );
        assert.equal(after.length, rows.length, 'the record stays');
        assert.ok(after.every((row) => row.released_ms && row.released_by));
    });

    it('refuses what is not a picture or a hash', async function () {
        assert.equal(
            (await j(admin, 'api/admin/quarantine', { address: 'https://example.org/cat.png' }))
                .status,
            400,
        );
        assert.equal((await j(admin, 'api/admin/quarantine', { hash: 'beef' })).status, 400);
    });
});

/*
    The refusal list (plans/SCANNING.md, step 3): a quarantined picture's PDQ fingerprint, never
    published. The same picture uploaded again - under another name, by anyone - is refused before
    it's kept; a different picture isn't. Meta's own regression pictures (node/tests/pdq).
*/
describe('quarantine: the refusal list', function () {
    this.timeout(180000);

    const fs = require('node:fs');
    const path = require('node:path');
    const bridge = (name) => fs.readFileSync(path.join(__dirname, '../../tests/pdq', name));

    let admin, ada, root, bea, beaRoot;

    // An upload's ingest, to its end: 'done' or the failure's words. Ada's by default; the same
    // bytes twice from one persona are one document, so the re-uploads are someone else's.
    const upload = async (bytes, title, who = ada, at = root) => {
        const up = await who(`api/identity/${at}/docs/binary?title=${encodeURIComponent(title)}`, {
            method: 'POST',
            body: bytes,
            file: true,
        });
        assert.equal(up.status, 202, await up.clone().text());
        const { doc_id, job_id } = await up.json();
        for (let i = 0; i < 400; i++) {
            const job = (await (await who(`api/identity/${at}/ingest`)).json()).find(
                (x) => x.job_id === job_id,
            );
            if (job && job.status === 'done') return { doc_id, done: true };
            if (job && job.status === 'failed') return { doc_id, error: job.error };
            await wait(150);
        }
        throw new Error('the ingest never finished');
    };

    before(async () => {
        admin = await makeUserFetch({ prefix: 'refuseadm' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
            HOST,
        );
        ada = await makeUserFetch({ prefix: 'refuseada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
        bea = await makeUserFetch({ prefix: 'refusebea' });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
    });

    it('fingerprints what it seals, and refuses the same picture uploaded again', async function () {
        const first = await upload(bridge('bridge-1-original.jpg'), 'a bridge');
        assert.ok(first.done, first.error);
        const d = await (
            await j(ada, `api/identity/${root}/docs`, {
                title: 'look',
                body: `![a bridge](/api/identity/${root}/docs/${first.doc_id}/body/bridge.avif)\n`,
                format: 'marquee',
            })
        ).json();
        const pub = await j(ada, `api/identity/${root}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        const post = (await pub.json()).post_id;
        const twin = ((await (await ada(`api/id/${root}/posts/${post}`)).json()).refs || [])[0];
        assert.ok(twin);

        const r = await j(admin, 'api/admin/quarantine', {
            address: `/ringtome/user/${root}/doc/${twin}/body`,
        });
        assert.equal(r.status, 200, await r.clone().text());
        const rows = (await r.json()).rows.filter((x) => x.doc_id === twin);
        assert.ok(
            rows.some((x) => x.printed),
            'the picture is on the refusal list',
        );

        // Scaled down and re-saved at a lower quality: other bytes, the same picture.
        const again = await upload(
            bridge('bridge-1-resized-900.jpg'),
            'definitely not a bridge',
            bea,
            beaRoot,
        );
        assert.ok(again.error, 'refused');
        assert.match(again.error, /can't be kept on this server/);

        const other = await upload(bridge('bridge-5-flipx.jpg'), 'another bridge');
        assert.ok(
            other.done,
            `a different picture - to PDQ, a mirror is one - is kept: ${other.error}`,
        );

        if (HOST_B) {
            // The same picture published on another node, and fetched here: sealed as it lands.
            const far = await makeUserFetch({ prefix: 'refusefar', host: HOST_B });
            const farRoot = (await (await far('api/identity', { method: 'POST' })).json())
                .root_pubkey;
            await far(`api/identity/${farRoot}/serve`, { method: 'POST' });
            const pic = await upload(
                bridge('bridge-1-resized-900.jpg'),
                'a far bridge',
                far,
                farRoot,
            );
            assert.ok(pic.done, `bravo has no refusal list of its own: ${pic.error}`);
            const fd = await (
                await j(far, `api/identity/${farRoot}/docs`, {
                    title: 'from afar',
                    body: `![a bridge](/api/identity/${farRoot}/docs/${pic.doc_id}/body/bridge.avif)\n`,
                    format: 'marquee',
                })
            ).json();
            const fpub = await j(far, `api/identity/${farRoot}/docs/${fd.doc_id}/publish`, {});
            assert.equal(fpub.status, 200, await fpub.clone().text());
            const fpost = (await fpub.json()).post_id;
            const ftwin = ((await (await far(`api/id/${farRoot}/posts/${fpost}`)).json()).refs ||
                [])[0];
            let key = '';
            for (let i = 0; i < 80 && key !== 'quarantine.removed-here'; i++) {
                const got = await bea(`id/${farRoot}/docs/${ftwin}/body`);
                assert.notEqual(got.status, 200, 'never served here');
                key = (await got.json().catch(() => ({}))).key || '';
                if (key !== 'quarantine.removed-here') await wait(250);
            }
            assert.equal(
                key,
                'quarantine.removed-here',
                'it arrived, matched its print, and was sealed',
            );
            const sealed = (await (await admin('api/admin/quarantine')).json()).rows.filter(
                (x) => x.by_account === 'refusal-list',
            );
            assert.ok(sealed.length >= 1, 'by the refusal list');
            rows.push(...sealed);
        }

        // Released, every one - and again, until a listing shows none left: the far copy's
        // thumbnail is checked on its own arrival and can be sealed a moment after its body (CI,
        // 2026-11-04: the list was read between the two, and the seal it missed kept the print
        // refused). Also clears a seal an earlier run left on a kept rig.
        for (const x of rows)
            await admin(`api/admin/quarantine/${x.hash}/release`, { method: 'POST' });
        for (let i = 0; i < 20; i++) {
            const left = (await (await admin('api/admin/quarantine')).json()).rows.filter(
                (x) => !x.released_ms && (x.doc_id === twin || x.by_account === 'refusal-list'),
            );
            if (!left.length) break;
            for (const x of left)
                await admin(`api/admin/quarantine/${x.hash}/release`, { method: 'POST' });
            await wait(250);
        }
        const freed = await upload(
            bridge('bridge-1-original.jpg'),
            'a bridge, released',
            bea,
            beaRoot,
        );
        assert.ok(freed.done, `released, it's welcome again: ${freed.error}`);
    });
});
