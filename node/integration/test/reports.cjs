/*
    Reports (plans/MODERATION.md, _Reports_; Curtis, 2026-11-02): a person asks the moderators they
    trust to consider an entry for their list. Both sides opt in or it bounces - the operator's
    "Allow Users to Accept Reports", the moderator's "Accept Reports" - and by default a moderator
    hears only from people they trust. A report carries the post as its author signed it; its
    words and pictures follow over HTTPS, and only bytes that hash to what was signed are kept. A
    child-abuse report carries the reference alone. Nothing lands on a chain.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, HOST_B, sql, makeFetch } = require('./fetch.cjs');
const { makeUserFetch, makePng, settleWith } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const settle = settleWith(40);

const persona = async (who) =>
    (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
const fact = (who, root, about, key, value) =>
    j(who, `api/identity/${root}/private/kv/contact:${about}/${key}`, { value }, 'PUT');

(HOST_B ? describe : describe.skip)('reports', function () {
    this.timeout(120000);

    // The moderator is the node's administrator on alpha; the reporter, the author and a stranger
    // live on bravo, so every report crosses the network.
    let admin, mod, rep, repRoot, author, authorRoot, post, stranger, strangerRoot;

    const policy = (users_may, extra = {}) =>
        j(
            admin,
            'api/admin/report-policy',
            { users_may, stranger_pool: 500, keep_days: 90, ...extra },
            'PUT',
        );
    const taking = (body) =>
        j(
            admin,
            `api/identity/${mod}/reports/settings`,
            { takes: true, reach: 1, strangers: false, ...body },
            'PUT',
        );
    const report = async (who, root, extra = {}) => {
        const r = await j(who, `api/identity/${root}/reports`, {
            kind: 'persona',
            target: authorRoot,
            reason: 'spam, all of it',
            item: { author: authorRoot, doc_id: post },
            ...extra,
        });
        assert.equal(r.status, 200, await r.clone().text());
        return (await r.json()).sent;
    };
    const queue = async () => await (await admin(`api/identity/${mod}/reports`)).json();
    const kept = async (reporter) =>
        (await sql(`SELECT id, standing FROM reports WHERE reporter = '${reporter}'`, HOST)).rows;

    before(async () => {
        admin = await makeUserFetch({ prefix: 'repadmin' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
            HOST,
        );
        mod = await persona(admin);
        await admin(`api/identity/${mod}/serve`, { method: 'POST' });

        author = await makeUserFetch({ prefix: 'repauthor', host: HOST_B });
        authorRoot = await persona(author);
        await author(`api/identity/${authorRoot}/serve`, { method: 'POST' });
        const d = await (
            await j(author, `api/identity/${authorRoot}/docs`, {
                title: 'Buy horses',
                body: 'spam spam spam, horses for sale',
                format: 'plaintext',
            })
        ).json();
        const pub = await j(author, `api/identity/${authorRoot}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        post = (await pub.json()).post_id;

        rep = await makeUserFetch({ prefix: 'reprep', host: HOST_B });
        repRoot = await persona(rep);
        stranger = await makeUserFetch({ prefix: 'repstranger', host: HOST_B });
        strangerRoot = await persona(stranger);
        // Both learn where the moderator lives, and tick them.
        const { toBase58 } = await import('../../js/speakable.js');
        const via = toBase58((await (await admin('api/node')).json()).endpoint_id);
        for (const [who, root] of [
            [rep, repRoot],
            [stranger, strangerRoot],
        ]) {
            assert.equal((await who(`api/id/${mod}/profile?via=${via}`)).status, 200);
            await fact(who, root, mod, 'moderates', 'yes');
        }
    });

    it("bounces while the operator doesn't allow it, or the moderator doesn't take them", async function () {
        await policy(false);
        assert.equal((await taking({})).status, 403, "the operator's switch comes first");
        assert.deepEqual(
            (await report(rep, repRoot)).map((s) => [s.moderator, s.outcome]),
            [[mod, 'not-taking']],
        );
        await policy(true);
        assert.deepEqual(
            (await report(rep, repRoot)).map((s) => s.outcome),
            ['not-taking'],
        );
        assert.deepEqual(await kept(repRoot), [], 'nothing kept');
    });

    it("bounces someone the moderator doesn't trust, at the door", async function () {
        assert.equal((await taking({})).status, 200);
        assert.deepEqual(
            (await report(rep, repRoot)).map((s) => s.outcome),
            ['not-taking'],
        );
        assert.deepEqual(await kept(repRoot), [], 'never stored');
    });

    it('takes it from someone they trust, with the words as the author signed them, over HTTPS', async function () {
        await fact(admin, mod, repRoot, 'trust', 'high');
        const sent = await report(rep, repRoot);
        assert.deepEqual(
            sent.map((s) => s.outcome),
            ['sent'],
        );
        assert.ok(sent[0].pictures >= 1, 'the body went to the upload address');
        const q = await queue();
        const mine = q.reports.filter((r) => r.reporter === repRoot);
        assert.equal(mine.length, 1);
        assert.equal(mine[0].standing, 'trusted');
        assert.equal(mine[0].item_doc, post);
        assert.equal(mine[0].item_title, 'Buy horses');
        assert.match(
            mine[0].words || '',
            /horses for sale/,
            'the words arrived, and are the signed ones',
        );
        assert.equal(mine[0].reason, 'spam, all of it');
        const chains = await sql(
            `SELECT COUNT(*) AS n FROM reports WHERE id = '${mine[0].id}'`,
            HOST,
        );
        assert.equal(Number(chains.rows[0].n), 1, 'kept once, in a table');
    });

    it('takes no bytes the author did not sign, and no address it did not hand out', async function () {
        const row = (
            await sql(`SELECT upload_token FROM reports WHERE reporter = '${repRoot}'`, HOST)
        ).rows[0];
        assert.ok(row.upload_token);
        const anon = makeFetch();
        const forged = await anon(`api/reports/upload/${row.upload_token}`, {
            method: 'POST',
            body: Buffer.from('this is not what they wrote'),
        });
        assert.equal(forged.status, 400);
        const nowhere = await anon(`api/reports/upload/${'0'.repeat(48)}`, {
            method: 'POST',
            body: Buffer.from('x'),
        });
        assert.equal(nowhere.status, 404);
    });

    it("lets an assistant only propose; the moderator's own tap lists", async function () {
        const [r] = (await queue()).reports.filter((x) => x.reporter === repRoot);
        const p = await j(admin, `api/identity/${mod}/reports/${r.id}/propose`, {
            level: 'block',
            reason: 'selling horses',
        });
        assert.equal(p.status, 200);
        const proposed = (await queue()).reports.find((x) => x.id === r.id);
        assert.equal(proposed.status, 'proposed');
        assert.deepEqual(proposed.proposal, { level: 'block', reason: 'selling horses' });
        const listed = (await (await admin(`api/identity/${mod}/moderation`)).json()).mine;
        assert.ok(!listed.some((m) => m.target === authorRoot), 'a proposal lists nobody');

        const l = await j(admin, `api/identity/${mod}/reports/${r.id}/list`, {
            level: 'warn',
            reason: 'selling horses',
        });
        assert.equal(l.status, 200, await l.clone().text());
        const mine = (await (await admin(`api/identity/${mod}/moderation`)).json()).mine;
        assert.ok(mine.some((m) => m.target === authorRoot && m.level === 'warn'));
        assert.ok(!(await queue()).reports.some((x) => x.id === r.id), 'done, off the queue');
        await admin(`api/identity/${mod}/moderation/persona/${authorRoot}`, { method: 'DELETE' });
    });

    it("takes strangers' reports into a bounded pool, when the moderator says so", async function () {
        assert.deepEqual(
            (await report(stranger, strangerRoot)).map((s) => s.outcome),
            ['not-taking'],
        );
        await taking({ strangers: true });
        await policy(true, { stranger_pool: 1 });
        const sent = await report(stranger, strangerRoot);
        assert.deepEqual(
            sent.map((s) => s.outcome),
            ['sent'],
        );
        const k = await kept(strangerRoot);
        assert.deepEqual(
            k.map((r) => r.standing),
            ['stranger'],
        );
        // A second stranger's report pushes the first out of a pool of one; the trusted one stays.
        await report(stranger, strangerRoot, { reason: 'and again' });
        assert.equal((await kept(strangerRoot)).length, 1, 'the pool holds one');
        await policy(true);
    });

    it('counts a flood by the node it came from, and drops it in one action', async function () {
        const q = await queue();
        const bravo = q.reports.find((r) => r.reporter === strangerRoot).from_node;
        const group = q.groups.find((g) => g.node === bravo);
        assert.ok(group && group.reports >= 1);
        const d = await j(admin, `api/identity/${mod}/reports/from/${bravo}/drop`, {
            block: false,
        });
        assert.equal(d.status, 200);
        assert.ok(!(await queue()).reports.some((r) => r.from_node === bravo), 'all dropped');
    });

    it("carries only the reference for a child being abused, and seals it at an administrator's door", async function () {
        const sent = await report(rep, repRoot, { child_abuse: true, reason: '' });
        assert.deepEqual(
            sent.map((s) => [s.outcome, s.pictures]),
            [['sent', 0]],
            'no picture travels',
        );
        const r = (await queue()).reports.find((x) => x.reporter === repRoot && x.child_abuse);
        assert.ok(r, 'in the queue, flagged');
        assert.equal(r.words, null, 'nothing of it came');
        const rows = (await (await admin('api/admin/quarantine')).json()).rows.filter(
            (x) => x.doc_id === post,
        );
        assert.ok(rows.length >= 1, 'its files are sealed here');
        assert.ok(rows.every((x) => !x.released_ms));
        assert.ok(
            rows.every((x) => x.reporter === repRoot),
            'each seal names whose report it was',
        );
        // Undone all at once, by reporter: every seal of theirs released, its row kept.
        const freed = await admin(`api/admin/quarantine/reported-by/${repRoot}/release`, {
            method: 'POST',
        });
        assert.equal(freed.status, 200, await freed.clone().text());
        const after = (await freed.json()).rows.filter((x) => x.doc_id === post);
        assert.equal(after.length, rows.length, 'the record stays');
        assert.ok(
            after.every((x) => x.released_ms),
            'and every one is released',
        );
        await j(admin, `api/identity/${mod}/reports/${r.id}/dismiss`, {});
    });

    // A post's picture is a document of its own: a report on the post has to reach it, on a node
    // that holds it and on one that has never seen it.
    describe('a post with a picture in it', function () {
        const anon = makeFetch();

        const picturePost = async (who, root, width) => {
            const pic = (
                await (
                    await who(`api/identity/${root}/docs/binary?title=a horse`, {
                        method: 'POST',
                        body: makePng(width, 41),
                        file: true,
                    })
                ).json()
            ).doc_id;
            for (let i = 0; i < 60; i++) {
                if ((await who(`api/identity/${root}/docs/${pic}/body`)).status === 200) break;
                await new Promise((r) => setTimeout(r, 250));
            }
            const d = await (
                await j(who, `api/identity/${root}/docs`, {
                    title: 'a picture',
                    body: `look\n\n![a horse](/api/identity/${root}/docs/${pic}/body/a-horse.png)\n`,
                    format: 'marquee',
                })
            ).json();
            const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, {});
            assert.equal(pub.status, 200, await pub.clone().text());
            const post_id = (await pub.json()).post_id;
            const head = await (await who(`api/id/${root}/posts/${post_id}`)).json();
            const twin = (head.refs || [])[0];
            assert.ok(twin, 'the post minted a public picture');
            const file = (await who(`id/${root}/docs/${twin}/body`)).headers.get('etag');
            return { post_id, twin, file: file.replaceAll('"', '') };
        };

        it('sends the picture to a moderator whose node has never seen it', async function () {
            const { post_id, twin, file } = await picturePost(author, authorRoot, 61);
            assert.equal(
                (await anon(`id/${authorRoot}/docs/${twin}/body`)).status,
                404,
                'the moderator node holds nothing of it',
            );
            const sent = await report(rep, repRoot, {
                reason: 'look at this',
                item: { author: authorRoot, doc_id: post_id },
            });
            assert.deepEqual(
                sent.map((s) => s.outcome),
                ['sent'],
            );
            assert.ok(sent[0].pictures >= 2, 'its words, and its picture');
            const r = (await queue()).reports.find((x) => x.item_doc === post_id);
            assert.ok(r.pictures.includes(file), 'the queue shows the picture');
            const shown = await admin(`api/identity/${mod}/reports/${r.id}/picture/${file}`);
            assert.equal(shown.status, 200);
            await j(admin, `api/identity/${mod}/reports/${r.id}/dismiss`, {});
        });

        it('a child-abuse report seals the picture too, with nothing uploaded', async function () {
            const { post_id, file } = await picturePost(author, authorRoot, 67);
            const sent = await report(rep, repRoot, {
                child_abuse: true,
                reason: '',
                item: { author: authorRoot, doc_id: post_id },
            });
            assert.deepEqual(
                sent.map((s) => [s.outcome, s.pictures]),
                [['sent', 0]],
                'no picture travels',
            );
            const rows = (await (await admin('api/admin/quarantine')).json()).rows.filter(
                (x) => x.doc_id === post_id,
            );
            assert.ok(
                rows.some((x) => x.hash === file && !x.released_ms),
                'sealed here before it ever arrives',
            );
            await admin(`api/admin/quarantine/reported-by/${repRoot}/release`, { method: 'POST' });
        });

        it('still goes when the post has more pictures than an envelope holds', async function () {
            const docs = [];
            for (let i = 0; i < 20; i++) {
                docs.push(
                    (
                        await (
                            await author(
                                `api/identity/${authorRoot}/docs/binary?title=horse ${i}`,
                                {
                                    method: 'POST',
                                    body: makePng(81 + i, 43),
                                    file: true,
                                },
                            )
                        ).json()
                    ).doc_id,
                );
            }
            for (const doc of docs) {
                for (let i = 0; i < 60; i++) {
                    const at = `api/identity/${authorRoot}/docs/${doc}/body`;
                    if ((await author(at)).status === 200) break;
                    await new Promise((r) => setTimeout(r, 250));
                }
            }
            const d = await (
                await j(author, `api/identity/${authorRoot}/docs`, {
                    title: 'an album',
                    body: docs
                        .map(
                            (doc) =>
                                `![a horse](/api/identity/${authorRoot}/docs/${doc}/body/a.png)`,
                        )
                        .join('\n\n'),
                    format: 'marquee',
                })
            ).json();
            const pub = await j(author, `api/identity/${authorRoot}/docs/${d.doc_id}/publish`, {});
            assert.equal(pub.status, 200, await pub.clone().text());
            const post_id = (await pub.json()).post_id;
            const sent = await report(rep, repRoot, {
                reason: 'x'.repeat(512),
                item: { author: authorRoot, doc_id: post_id },
            });
            assert.deepEqual(
                sent.map((s) => s.outcome),
                ['sent'],
            );
            const r = (await queue()).reports.find((x) => x.item_doc === post_id);
            assert.ok(r.pictures.length >= 3, 'the first few arrive, at the longest reason');
            await j(admin, `api/identity/${mod}/reports/${r.id}/dismiss`, {});
        });

        it('takes the picture down on the node that serves it', async function () {
            const neighbour = await makeUserFetch({ prefix: 'repneighbour' });
            const neighbourRoot = await persona(neighbour);
            await neighbour(`api/identity/${neighbourRoot}/serve`, { method: 'POST' });
            const { post_id, twin } = await picturePost(neighbour, neighbourRoot, 71);
            const near = await makeUserFetch({ prefix: 'repnear' });
            const nearRoot = await persona(near);
            await fact(near, nearRoot, mod, 'moderates', 'yes');
            await fact(admin, mod, nearRoot, 'trust', 'high');
            const picture = `id/${neighbourRoot}/docs/${twin}/body`;
            assert.equal((await anon(picture)).status, 200);
            await report(near, nearRoot, {
                target: neighbourRoot,
                child_abuse: true,
                reason: '',
                item: { author: neighbourRoot, doc_id: post_id },
            });
            assert.equal((await anon(`id/${neighbourRoot}/docs/${post_id}/body`)).status, 404);
            assert.equal((await anon(picture)).status, 404, 'the picture');
            assert.equal(
                (await anon(`id/${neighbourRoot}/docs/${twin}/thumb`)).status,
                404,
                'and its thumbnail',
            );
            await admin(`api/admin/quarantine/reported-by/${nearRoot}/release`, { method: 'POST' });
            assert.equal((await anon(picture)).status, 200, 'and all of it comes back');

            // A post's address reaches its picture as well, for an operator's seal and for a list.
            const address = `/ringtome/user/${neighbourRoot}/doc/${post_id}/body`;
            const listed = await j(admin, `api/identity/${mod}/moderation/by-address`, {
                address,
                level: 'warn',
                reason: 'the picture, not the words',
            });
            assert.equal(listed.status, 200, await listed.clone().text());
            const file = (await anon(picture)).headers.get('etag').replaceAll('"', '');
            assert.equal((await listed.json()).hash, file, 'the list names the picture');
            const sealed = await j(admin, 'api/admin/quarantine', { address, why: 'by its post' });
            assert.equal(sealed.status, 200, await sealed.clone().text());
            assert.equal((await anon(picture)).status, 404, 'sealed by its post');
            assert.equal(
                (await admin(`api/admin/quarantine/${file}/release`, { method: 'POST' })).status,
                200,
            );
        });
    });

    it("refuses a child-abuse report from a stranger, even from a moderator who takes strangers' reports", async function () {
        await taking({ strangers: true });
        const before = (await kept(strangerRoot)).length;
        const sent = await report(stranger, strangerRoot, { child_abuse: true, reason: '' });
        assert.deepEqual(
            sent.map((s) => s.outcome),
            ['not-taking'],
        );
        assert.equal((await kept(strangerRoot)).length, before, 'and keeps nothing of it');
        const ordinary = await report(stranger, strangerRoot, { reason: 'just spam' });
        assert.deepEqual(
            ordinary.map((s) => s.outcome),
            ['sent'],
            'their other reports still come in',
        );
        await taking({});
    });

    it('a report about yourself, or past 512 bytes, is never sent', async function () {
        const self = await j(rep, `api/identity/${repRoot}/reports`, {
            kind: 'persona',
            target: repRoot,
            reason: '',
        });
        assert.ok(
            self.status >= 400 || (await self.json()).sent.every((s) => s.outcome !== 'sent'),
        );
        const long = await j(rep, `api/identity/${repRoot}/reports`, {
            kind: 'persona',
            target: authorRoot,
            reason: 'x'.repeat(513),
        });
        assert.equal(long.status, 400);
    });
});
