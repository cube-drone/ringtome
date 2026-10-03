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
