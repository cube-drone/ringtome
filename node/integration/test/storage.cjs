/*
    Storage accounting (storage.rs, 2026-10-02): what a persona's files take, what the persona costs
    to move, what evicting it would free - and the per-persona figures for the node admin only.
    Tallies are memos, retaken when a persona's files move: these claims read them through the doors.
*/
const assert = require('node:assert');
const { sql, makeFetch } = require('./fetch.cjs');
const { makeUserFetch, makePng } = require('./helpers.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('storage accounting', function () {
    this.timeout(60000);
    let me, root, pic;

    before(async () => {
        me = await makeUserFetch({ prefix: 'store' });
        root = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
        pic = (
            await (
                await me(`api/identity/${root}/docs/binary?title=plate`, {
                    method: 'POST',
                    body: makePng(64, 48),
                    file: true,
                })
            ).json()
        ).doc_id;
        for (let i = 0; i < 60; i++) {
            if ((await me(`api/identity/${root}/docs/${pic}/body`)).status === 200) break;
            await wait(300);
        }
    });

    it('says what each file takes, and what the persona costs to move', async () => {
        // The tally is retaken once the persona's files move and a moment has passed: ask until the
        // picture's bytes are in it.
        let s;
        for (let i = 0; i < 40; i++) {
            s = await (await me(`api/identity/${root}/storage`)).json();
            if (s.docs && s.docs[pic] > 0) break;
            await wait(500);
        }
        assert.ok(s.docs[pic] > 0, `the picture has a size: ${JSON.stringify(s)}`);
        assert.ok(s.files_bytes >= s.docs[pic], "the files' total holds it");
        assert.ok(s.db_bytes > 0, "the persona's own database counts");
        assert.equal(
            s.move_bytes,
            s.files_bytes + s.db_bytes,
            'moving carries the files and the database',
        );
        assert.ok(
            s.evict_bytes > 0 && s.evict_bytes <= s.move_bytes,
            'evicting frees at most what moving carries',
        );
    });

    it("is the persona's own business: another account is refused", async () => {
        const stranger = await makeUserFetch({ prefix: 'nosy' });
        assert.notEqual((await stranger(`api/identity/${root}/storage`)).status, 200);
    });

    it('the Storage page: the place in all, the persona, and each person followed (2026-11-20)', async () => {
        // Someone to follow, held here: another account's persona on this node.
        const them = await makeUserFetch({ prefix: 'storefol' });
        const theirs = (await (await them('api/identity', { method: 'POST' })).json()).root_pubkey;
        const put = await me(`api/identity/${root}/private/kv/contact:${theirs}/interest`, {
            method: 'PUT',
            body: JSON.stringify({ value: 'high' }),
        });
        assert.equal(put.status, 200, await put.text());
        // The follow reaches the node's memo of who follows whom a moment after the write.
        let o;
        for (let i = 0; i < 40; i++) {
            o = await (await me(`api/identity/${root}/storage/overview`)).json();
            if ((o.following || []).some((p) => p.root === theirs)) break;
            await wait(500);
        }
        const place = o.place;
        assert.ok(place.total_bytes > 0, JSON.stringify(place));
        assert.equal(
            place.total_bytes,
            place.files_bytes + place.chains_bytes + place.backups_bytes + place.other_bytes,
            'the kinds are the whole',
        );
        assert.ok(place.files_bytes > 0, 'the picture is in the files');
        assert.ok(
            place.disk_total_bytes > place.total_bytes &&
                place.disk_free_bytes <= place.disk_total_bytes,
            `the disk it is all on, and what is left of it: ${JSON.stringify(place)}`,
        );
        assert.ok(place.chains_bytes > 0, "and the personas' databases in the records");

        const own = await (await me(`api/identity/${root}/storage`)).json();
        assert.equal(
            o.persona.files_bytes,
            own.files_bytes,
            "the persona's files, as its own tally says",
        );
        assert.equal(o.persona.bytes, o.persona.files_bytes + o.persona.chains_bytes);
        assert.ok(o.persona.chains_bytes > 0);
        // The files by kind and by lane: the picture is a picture, the kinds are the whole, and so
        // are the two lanes.
        const kinds = o.persona.kinds;
        assert.ok(kinds.pictures > 0, `the picture counts as pictures: ${JSON.stringify(kinds)}`);
        assert.equal(
            kinds.pictures + kinds.video + kinds.audio + kinds.writing + kinds.other,
            o.persona.files_bytes,
            'the kinds are the files',
        );
        assert.equal(o.persona.public_bytes + o.persona.private_bytes, o.persona.files_bytes);
        assert.ok(o.persona.private_bytes > 0, 'an uploaded picture is private until published');
        // And each lane by kind: the two together are the kinds, the picture among the private.
        const { public_kinds, private_kinds } = o.persona;
        for (const kind of Object.keys(kinds)) {
            assert.equal(public_kinds[kind] + private_kinds[kind], kinds[kind], kind);
        }
        assert.ok(private_kinds.pictures > 0, JSON.stringify(private_kinds));
        assert.equal(
            Object.values(public_kinds).reduce((a, b) => a + b, 0),
            o.persona.public_bytes,
            'the public kinds are the public files',
        );

        let followed = o.following.find((p) => p.root === theirs);
        assert.ok(followed, `the person followed is listed: ${JSON.stringify(o.following)}`);
        assert.ok(followed.bytes > 0, 'with what they take here');
        // A person followed is tallied on the ask, and then says their files by kind too.
        for (let i = 0; i < 40 && !followed.counted; i++) {
            await wait(500);
            o = await (await me(`api/identity/${root}/storage/overview`)).json();
            followed = o.following.find((p) => p.root === theirs);
        }
        assert.ok(followed.counted && followed.kinds, JSON.stringify(followed));
        assert.equal(followed.bytes, followed.files_bytes + followed.chains_bytes);
        assert.ok(!o.following.some((p) => p.root === root), 'and never the asker themselves');
        assert.ok(o.others.people >= 0 && o.others.bytes >= 0);

        // Whom a persona follows is its own business.
        assert.notEqual((await them(`api/identity/${root}/storage/overview`)).status, 200);
    });

    it("gives every persona's figures to a node admin, and to nobody else", async () => {
        assert.equal((await me('api/node/storage')).status, 403, 'a member is refused');
        const admin = await makeUserFetch({ prefix: 'storeadm' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
        );
        const all = await (await admin('api/node/storage')).json();
        const mine = all.personas[root];
        assert.ok(mine, 'the tallied persona is listed');
        assert.ok(
            mine.move_bytes > 0 && mine.evict_bytes > 0 && mine.evict_bytes <= mine.move_bytes,
            JSON.stringify(mine),
        );
    });
});
