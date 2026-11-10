/*
    A listed picture's sketch (sketches.rs; Curtis, 2026-11-05): a list entry names a picture by
    its hash alone, so its keeper is shown a 48-pixel black-and-white sketch of it beside the entry -
    on their own list only, never on the public one, gone when they take the entry off, and gone for
    everyone the moment the picture is quarantined.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, sql } = require('./fetch.cjs');
const { makeUserFetch, makePng } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('picture sketches', function () {
    this.timeout(120000);

    let admin, keeper, keeperRoot, other, otherRoot, author, authorRoot, twin, hash;
    const address = () => `/ringtome/user/${authorRoot}/doc/${twin}/body`;
    const mine = async (who, root) =>
        ((await (await who(`api/identity/${root}/moderation`)).json()).mine || []).find(
            (r) => r.kind === 'picture' && r.target === hash,
        );
    const kept = async () =>
        Number(
            (await sql(`SELECT COUNT(*) AS n FROM picture_sketches WHERE hash = '${hash}'`, HOST))
                .rows[0].n,
        );
    const list = async () => {
        const r = await j(keeper, `api/identity/${keeperRoot}/moderation/by-address`, {
            address: address(),
            level: 'block',
            reason: 'the one with the spam on it',
        });
        assert.equal(r.status, 200, await r.clone().text());
        hash = (await r.json()).hash;
    };

    before(async () => {
        admin = await makeUserFetch({ prefix: 'sketchadmin' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
            HOST,
        );
        keeper = await makeUserFetch({ prefix: 'sketchkeep' });
        keeperRoot = (await (await keeper('api/identity', { method: 'POST' })).json()).root_pubkey;
        other = await makeUserFetch({ prefix: 'sketchother' });
        otherRoot = (await (await other('api/identity', { method: 'POST' })).json()).root_pubkey;
        author = await makeUserFetch({ prefix: 'sketchauthor' });
        authorRoot = (await (await author('api/identity', { method: 'POST' })).json()).root_pubkey;
        await author(`api/identity/${authorRoot}/serve`, { method: 'POST' });
        const pic = (
            await (
                await author(`api/identity/${authorRoot}/docs/binary?title=a horse`, {
                    method: 'POST',
                    // A size no other claim uploads: crushes are deterministic.
                    body: makePng(61, 37),
                    file: true,
                })
            ).json()
        ).doc_id;
        for (let i = 0; i < 60; i++) {
            if ((await author(`api/identity/${authorRoot}/docs/${pic}/body`)).status === 200) break;
            await wait(250);
        }
        // Published, so the picture is a public one (the post mints its twin).
        const d = await (
            await j(author, `api/identity/${authorRoot}/docs`, {
                title: 'a picture',
                body: `look\n\n![a horse](/api/identity/${authorRoot}/docs/${pic}/body/a-horse.png)\n`,
                format: 'marquee',
            })
        ).json();
        const pub = await j(author, `api/identity/${authorRoot}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        const post = (await pub.json()).post_id;
        twin = ((await (await author(`api/id/${authorRoot}/posts/${post}`)).json()).refs || [])[0];
        assert.ok(twin, 'the post minted a public picture');
    });

    it("shows the list's keeper a small black-and-white sketch, and nobody else", async function () {
        await list();
        const row = await mine(keeper, keeperRoot);
        assert.ok(row, 'listed');
        assert.match(row.sketch || '', /^data:image\/png;base64,/, 'with its sketch');
        const png = Buffer.from(row.sketch.split(',')[1], 'base64');
        assert.ok(png.length < 1024, `${png.length} bytes`);
        // PNG's header: width and height, big-endian, at 16 and 20.
        assert.ok(png.readUInt32BE(16) <= 48 && png.readUInt32BE(20) <= 48, 'within 48 pixels');

        const others = await (await other(`api/identity/${otherRoot}/moderation`)).json();
        assert.ok(!JSON.stringify(others).includes('data:image'), "not in anyone else's view");
        const said = await sql(`SELECT * FROM moderation_said WHERE target = '${hash}'`, HOST);
        assert.ok(!JSON.stringify(said.rows).includes('data:image'), 'nor on the public list');
    });

    it('goes when the entry is taken off', async function () {
        const r = await keeper(`api/identity/${keeperRoot}/moderation/picture/${hash}`, {
            method: 'DELETE',
        });
        assert.equal(r.status, 200, await r.clone().text());
        assert.equal(await kept(), 0);
    });

    it('goes for everyone when the picture is quarantined, and is never drawn again', async function () {
        await list();
        assert.equal(await kept(), 1, 'kept again');
        const q = await j(admin, 'api/admin/quarantine', {
            address: address(),
            why: 'sketch claim',
        });
        assert.equal(q.status, 200, await q.clone().text());
        assert.equal(await kept(), 0, 'gone at the seal');
        const row = await mine(keeper, keeperRoot);
        assert.ok(row && !row.sketch, 'the entry stays, without it');

        await list();
        assert.equal(await kept(), 0, 'a sealed picture is never read to draw one');
    });

    after(async () => {
        const rows = (await (await admin('api/admin/quarantine')).json()).rows.filter(
            (row) => row.doc_id === twin,
        );
        for (const row of rows)
            await admin(`api/admin/quarantine/${row.hash}/release`, { method: 'POST' });
    });
});
