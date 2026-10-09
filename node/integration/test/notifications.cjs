/*
    The publication rung, end to end on one node: dialing a contact mints a signed public-edge
    statement onto the author's follows-public chain (publish::reconcile - publication is the
    resting state, so the dial IS the act and `edges_public: no` is what withholds), the
    notification fold routes it to the local personas that follow the author
    (notifications::refresh_from), and the endpoint serves it dressed with seen-state from the
    reader's own private chain.

    Everything below is the DERIVED path (PROJECT_PLAN, Arrival and Attention: the follow-edge
    rule): the reader follows the author, which is why the author's chains are here to fold.
    The non-follower case pins the boundary - reaching someone who doesn't follow you is the
    inbox path's job, and it must NOT leak through this one.
*/
const assert = require('node:assert');
const { sql, HOST_B } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');

const dial = (fetcher, mine, theirs, key, value) =>
    fetcher(`api/identity/${mine}/private/kv/contact:${theirs}/${key}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
    });

let author, authorRoot, reader, readerRoot, bystander, bystanderRoot;

before(async () => {
    author = await makeUserFetch({ prefix: 'pubauthor' });
    authorRoot = (await (await author('api/identity', { method: 'POST' })).json()).root_pubkey;
    reader = await makeUserFetch({ prefix: 'pubreader' });
    readerRoot = (await (await reader('api/identity', { method: 'POST' })).json()).root_pubkey;
    bystander = await makeUserFetch({ prefix: 'pubbystander' });
    bystanderRoot = (await (await bystander('api/identity', { method: 'POST' })).json())
        .root_pubkey;

    // The reader follows the author - the follow-edge that licenses the derived path. The
    // bystander deliberately does not.
    await dial(reader, readerRoot, authorRoot, 'interest', 'high');
});

const notificationRows = async (readerHex) => {
    const { rows } = await sql(
        `SELECT author_root, kind, trust, interest, updated_ms FROM notifications
         WHERE reader_root = '${readerHex}'`,
    );
    return rows;
};

describe('edge publication and its notification', () => {
    it('dialing a relationship mints the statement and the follower is notified', async () => {
        // No `edges_public` write anywhere here: publication is the resting state, so the
        // dials themselves are the publishing act (settled 2026-08-09).
        await dial(author, authorRoot, readerRoot, 'trust', 'max');
        await dial(author, authorRoot, readerRoot, 'interest', 'medium');

        await beat(undefined, 'mint', authorRoot);
        await beat(undefined, 'fold', authorRoot);
        const rows = await notificationRows(readerRoot);
        assert.ok(
            rows.length && rows[0].trust === 'max' && rows[0].interest === 'medium',
            'the published edge became a notification row',
        );
        assert.equal(rows.length, 1, 'collapse by (sender, kind): one row per author');
        assert.equal(rows[0].author_root, authorRoot);
        assert.equal(rows[0].kind, 'public-edge');
        assert.equal(rows[0].trust, 'max', 'the band as published, as set');
        assert.equal(rows[0].interest, 'medium');
    });

    it('a dial turned while consented updates the row in place - quietly, its moment kept (2026-10-02)', async () => {
        // Curtis: a follower turning their interest DOWN rang his bell, "follows and vouches for you".
        // Only a first follow or a first trust is news; a level moving is not.
        const before = Number((await notificationRows(readerRoot))[0].updated_ms);
        await dial(author, authorRoot, readerRoot, 'trust', 'high');
        await beat(undefined, 'mint', authorRoot);
        await beat(undefined, 'fold', authorRoot);
        let rows = await notificationRows(readerRoot);
        assert.ok(
            rows.length === 1 && rows[0].trust === 'high',
            'the statement was re-published and the row updated, never stacked',
        );
        assert.equal(Number(rows[0].updated_ms), before, 'trust turned down: not news');
        await dial(author, authorRoot, readerRoot, 'interest', 'low');
        await beat(undefined, 'mint', authorRoot);
        await beat(undefined, 'fold', authorRoot);
        rows = await notificationRows(readerRoot);
        assert.equal(rows[0].interest, 'low', 'the words stay true');
        assert.equal(Number(rows[0].updated_ms), before, 'interest turned down: not news either');
    });

    it('a first trust after a follow IS news: the row comes back to the top (2026-10-02)', async () => {
        // A pair of its own, so the shared reader's single row stays single for the claims below.
        const fan = await makeUserFetch({ prefix: 'pubfan' });
        const fanRoot = (await (await fan('api/identity', { method: 'POST' })).json()).root_pubkey;
        const watcher = await makeUserFetch({ prefix: 'pubwatcher' });
        const watcherRoot = (await (await watcher('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        await dial(watcher, watcherRoot, fanRoot, 'interest', 'high'); // the watcher follows the fan, so it folds
        await dial(fan, fanRoot, watcherRoot, 'interest', 'medium');
        await beat(undefined, 'mint', fanRoot);
        await beat(undefined, 'fold', fanRoot);
        const row = async () =>
            (await notificationRows(watcherRoot)).find((r) => r.author_root === fanRoot);
        const followed = await row();
        assert.ok(
            followed && !followed.trust,
            `a follow, no trust yet: ${JSON.stringify(followed)}`,
        );
        await new Promise((r) => setTimeout(r, 20));
        await dial(fan, fanRoot, watcherRoot, 'trust', 'max');
        await beat(undefined, 'mint', fanRoot);
        await beat(undefined, 'fold', fanRoot);
        const trusted = await row();
        assert.equal(trusted.trust, 'max');
        assert.ok(
            Number(trusted.updated_ms) > Number(followed.updated_ms),
            'the first trust stamps it anew',
        );
    });

    it('the endpoint dresses the row, and the watermark makes it seen everywhere', async () => {
        const page = await (await reader(`api/identity/${readerRoot}/notifications`)).json();
        assert.equal(page.items.length, 1);
        const item = page.items[0];
        assert.equal(item.author, authorRoot);
        assert.equal(item.kind, 'public-edge');
        assert.equal(item.seen, false, 'nothing marked yet');

        await reader(`api/identity/${readerRoot}/private/kv/notifications_seen/watermark`, {
            method: 'PUT',
            body: JSON.stringify({ value: String(item.updated_ms) }),
        });
        const after = await (await reader(`api/identity/${readerRoot}/notifications`)).json();
        assert.equal(after.items[0].seen, true, 'the watermark is the seen cursor');
        assert.equal(after.watermark, item.updated_ms);
    });

    it("a published edge toward a NON-follower notifies nobody - the derived path's boundary", async () => {
        await dial(author, authorRoot, bystanderRoot, 'trust', 'max');

        // The statement mints regardless (publication is the author's act; who reads it is
        // not the mint's business) - proven by the follower case above. What must NOT happen
        // is a row for someone who never chose to sync this author.
        // The pass, provably run and provably silent for the bystander - no sleep needed.
        await beat(undefined, 'mint', authorRoot);
        await beat(undefined, 'fold', authorRoot);
        assert.deepEqual(
            await notificationRows(bystanderRoot),
            [],
            'no follow-edge, no derived notification',
        );
    });

    it('going private retracts the statement and the notification with it', async () => {
        await dial(author, authorRoot, readerRoot, 'edges_public', 'no');
        await beat(undefined, 'mint', authorRoot);
        await beat(undefined, 'fold', authorRoot);
        assert.equal(
            (await notificationRows(readerRoot)).length,
            0,
            'a retraction is an absence, not a notification',
        );
    });
});

/*
    The bell's seen-state is the persona's, so its stamps must be too (2026-10-09). Curtis synced
    his phone to his persona and its bell lit with news he had read weeks before, dated minutes
    ago: the phone stamped every row with its own arrival - the moment the backlog crossed - and
    the watermark set on his other computers was older than all of it. A row is stamped when the
    PERSONA first heard of it (routes.rs `persona_stamp`), and that is what crosses to a new
    computer with the watermark.
*/
(HOST_B ? describe : describe.skip)("the bell across a persona's computers", function () {
    this.timeout(120000);

    it('news read on one computer arrives read on a computer that joins later', async () => {
        const fan = await makeUserFetch({ prefix: 'bellfan' });
        const fanRoot = (await (await fan('api/identity', { method: 'POST' })).json()).root_pubkey;
        const owner = await makeUserFetch({ prefix: 'bellowner' });
        const ownerRoot = (await (await owner('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        await dial(owner, ownerRoot, fanRoot, 'interest', 'high'); // the owner follows the fan
        await dial(fan, fanRoot, ownerRoot, 'interest', 'high');
        await beat(undefined, 'mint', fanRoot);
        await beat(undefined, 'fold', fanRoot);

        // Read on the first computer: the bell shows the follow, and the owner marks it read.
        const bell = async (fetcher) =>
            (await (await fetcher(`api/identity/${ownerRoot}/notifications`)).json()).items.find(
                (i) => i.author === fanRoot && i.kind === 'public-edge',
            );
        const onA = await bell(owner);
        assert.ok(onA && !onA.seen, `news on the first computer: ${JSON.stringify(onA)}`);
        await owner(`api/identity/${ownerRoot}/private/kv/notifications_seen/watermark`, {
            method: 'PUT',
            body: JSON.stringify({ value: String(onA.updated_ms) }),
        });
        assert.equal((await bell(owner)).seen, true);

        // Later, a second computer joins the persona and receives the fan's chain fresh.
        await new Promise((r) => setTimeout(r, 50));
        const ownerOnB = await makeUserFetch({ prefix: 'bellownerb', host: HOST_B });
        const request = await (
            await ownerOnB('api/identity/adopt/begin', { method: 'POST' })
        ).json();
        const grant = await (
            await owner(`api/identity/${ownerRoot}/nodes`, {
                method: 'POST',
                body: JSON.stringify({ code: request.code }),
            })
        ).json();
        const done = await ownerOnB('api/identity/adopt/complete', {
            method: 'POST',
            body: JSON.stringify({ code: grant.code }),
        });
        assert.equal(done.status, 200, await done.text());
        await beat(undefined, 'eager-push', ownerRoot);
        await beat(HOST_B, 'fold', ownerRoot);

        let onB;
        for (let attempt = 0; attempt < 20 && !onB; attempt++) {
            await beat(HOST_B, 'follow-refresh');
            await beat(HOST_B, 'pull', fanRoot);
            await beat(HOST_B, 'fold', fanRoot);
            onB = await bell(ownerOnB);
            if (!onB) await new Promise((r) => setTimeout(r, 250));
        }
        assert.ok(onB, "the fan's follow reached the second computer's bell");
        assert.equal(onB.seen, true, 'read on one computer is read on all of them');
        assert.ok(
            onB.updated_ms <= onA.updated_ms,
            `stamped when the persona heard it (${onA.updated_ms}), not when this computer did (${onB.updated_ms})`,
        );
    });
});
