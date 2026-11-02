/*
    Moderation lists (plans/MODERATION.md; Curtis, 2026-11-02): a persona publishes a list of
    sources to block or warn about, each with a reason, on a public chain. A reader takes the
    entries of the people they ticked as moderating for them - one hop - plus their own, minus
    the ones they overrule; where sources disagree, block beats warn, and every source and
    reason stays readable.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, HOST_B, sql } = require('./fetch.cjs');
const { makeUserFetch, settleWith } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const persona = async (prefix, host) => {
    const who = await makeUserFetch({ prefix, ...(host ? { host } : {}) });
    const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
    return { who, root };
};
const list = (p, target, level, reason, kind = 'persona') =>
    j(p.who, `api/identity/${p.root}/moderation/${kind}/${target}`, { level, reason }, 'PUT');
const unlist = (p, target, kind = 'persona') =>
    p.who(`api/identity/${p.root}/moderation/${kind}/${target}`, { method: 'DELETE' });
const view = async (p) => (await p.who(`api/identity/${p.root}/moderation`)).json();
const fact = (p, about, key, value) =>
    j(p.who, `api/identity/${p.root}/private/kv/contact:${about}/${key}`, { value }, 'PUT');
const settle = settleWith(40);

const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};

describe('moderation lists', function () {
    this.timeout(120000);

    let mod, other, reader, troll;

    before(async () => {
        mod = await persona('modmod');
        other = await persona('modother');
        reader = await persona('modreader');
        troll = await persona('modtroll');
    });

    it("keeps a persona's own list: listed, changed, taken off", async function () {
        const put = await list(mod, troll.root, 'warn', 'rude about horses');
        assert.equal(put.status, 200, await put.clone().text());
        let mine = (await view(mod)).mine;
        assert.deepEqual(
            mine.map((m) => [m.kind, m.target, m.level, m.reason]),
            [['persona', troll.root, 'warn', 'rude about horses']],
        );

        await list(mod, troll.root, 'block', 'rude about horses, again');
        mine = (await view(mod)).mine;
        assert.equal(mine.length, 1, 'restating overwrites, never stacks');
        assert.equal(mine[0].level, 'block');

        assert.equal((await unlist(mod, troll.root)).status, 200);
        assert.deepEqual((await view(mod)).mine, [], 'a retraction takes it off');
    });

    it('refuses a reason past 512 bytes, counted in bytes, and listing yourself', async function () {
        assert.equal((await list(mod, troll.root, 'warn', 'x'.repeat(512))).status, 200);
        // 171 three-byte characters: 513 bytes, though only 171 characters.
        assert.equal((await list(mod, troll.root, 'warn', '说'.repeat(171))).status, 400);
        assert.equal(
            (await view(mod)).mine[0].reason,
            'x'.repeat(512),
            'the refusal changed nothing',
        );
        assert.equal((await list(mod, mod.root, 'block', 'me')).status, 400);
        assert.equal((await list(mod, troll.root, 'smite', '')).status, 400);
        assert.equal((await list(mod, troll.root, 'warn', '', 'planet')).status, 400);
        await unlist(mod, troll.root);
    });

    it('takes the entries of the moderators a reader ticked, one hop, block over warn', async function () {
        await list(mod, troll.root, 'warn', 'rude about horses');
        await list(other, troll.root, 'block', 'spam, all of it');
        // `other` trusts `mod` to moderate: what `mod` says must not reach `reader` through
        // `other` - one hop only.
        await fact(other, mod.root, 'moderates', 'yes');

        assert.deepEqual((await view(reader)).taken, [], 'nobody ticked: nothing taken');

        await fact(reader, other.root, 'moderates', 'yes');
        let taken = (await view(reader)).taken;
        assert.equal(taken.length, 1);
        assert.equal(taken[0].target, troll.root);
        assert.equal(taken[0].level, 'block');
        assert.deepEqual(
            taken[0].sources.map((s) => [s.author, s.reason]),
            [[other.root, 'spam, all of it']],
            "only other's own word: mod's arrives through nobody",
        );

        await fact(reader, mod.root, 'moderates', 'yes');
        taken = (await view(reader)).taken;
        assert.equal(taken[0].level, 'block', 'block beats warn');
        assert.deepEqual(
            taken[0].sources.map((s) => [s.author, s.level]),
            [
                [other.root, 'block'],
                [mod.root, 'warn'],
            ],
            'both reasons stay readable, the strongest first',
        );
        assert.deepEqual((await view(reader)).moderators.sort(), [mod.root, other.root].sort());
    });

    it('lets a reader overrule an entry, and untick a moderator', async function () {
        const add = await j(
            reader.who,
            `api/identity/${reader.root}/private/set/moderation_overrules`,
            {
                element: `persona:${troll.root}`,
            },
        );
        assert.ok(add.ok, await add.clone().text());
        assert.equal((await view(reader)).taken[0].overruled, true, 'their own word is the last');

        await fact(reader, other.root, 'moderates', 'no');
        await fact(reader, mod.root, 'moderates', 'no');
        assert.deepEqual((await view(reader)).taken, [], 'unticked: nothing taken');
    });

    it("carries a moderator's list to a reader on another node", async function () {
        const far = await persona('modfar', HOST_B);
        await far.who(`api/identity/${far.root}/serve`, { method: 'POST' });
        await mod.who(`api/identity/${mod.root}/serve`, { method: 'POST' });
        const seen = await far.who(`api/id/${mod.root}/profile?via=${await base58(mod.who)}`);
        if (seen.status !== 200) this.skip();
        await fact(far, mod.root, 'moderates', 'yes');
        const taken = await settle(async () => {
            const t = (await view(far)).taken;
            return t.length ? t : null;
        });
        assert.ok(taken, 'the list arrived');
        assert.equal(taken[0].target, troll.root);
        assert.equal(taken[0].sources[0].reason, 'rude about horses');
        // Held as a follow is (a routing fact, like interest): wanted here, never left to expire.
        const sub = async () =>
            (
                await sql(
                    `SELECT moderates FROM subscriptions WHERE local_root = '${far.root}' AND foreign_root = '${mod.root}'`,
                    HOST_B,
                )
            ).rows;
        assert.deepEqual(
            (await sub()).map((r) => Number(r.moderates)),
            [1],
            'the moderator is someone this node wants',
        );
        await fact(far, mod.root, 'moderates', 'no');
        assert.deepEqual(await sub(), [], 'unticked, and only that: no row');
    });
});

/*
    What a node refuses (plans/MODERATION.md, steps 2-3): the block-level entries its
    administrators take, as administrators. A refused persona is never synced, fetched or shelved,
    and what the node held of them goes; a refused node is never dialled; the node's own users are
    never refused.
*/
(HOST_B ? describe : describe.skip)('moderation lists: what a node refuses', function () {
    this.timeout(120000);

    let admin, reader, far, farPost;

    const journal = async (author) =>
        (
            await sql(
                `SELECT doc_id FROM feed_journal WHERE reader_root = '${reader.root}' AND author_root = '${author}'`,
                HOST,
            )
        ).rows;
    const profile = async (p, root, via) =>
        (await p.who(`api/id/${root}/profile?via=${via}`)).status;

    before(async () => {
        admin = await persona('refuseadmin');
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.who.account.id}', 'node_admin')`,
            HOST,
        );
        reader = await persona('refusereader');
        far = await persona('refusefar', HOST_B);
        await far.who(`api/identity/${far.root}/serve`, { method: 'POST' });
        const d = await (
            await j(far.who, `api/identity/${far.root}/docs`, {
                title: 'Far opinions',
                body: 'horses, from afar',
                format: 'plaintext',
            })
        ).json();
        await j(far.who, `api/identity/${far.root}/docs/${d.doc_id}/publish`, {});
        farPost = d.doc_id;
    });

    it("clears a followed persona off the node when an administrator's list blocks them", async function () {
        const via = await base58(far.who);
        if ((await profile(reader, far.root, via)) !== 200) this.skip();
        await fact(reader, far.root, 'interest', 'high');
        const arrived = await settle(async () => (await journal(far.root)).length > 0);
        if (!arrived) this.skip();

        const put = await list(admin, far.root, 'block', 'spam from afar');
        assert.equal(put.status, 200, await put.clone().text());
        assert.ok(
            await settle(async () => (await journal(far.root)).length === 0),
            "the follower's feed no longer holds them",
        );
        assert.notEqual(
            await profile(reader, far.root, via),
            200,
            'and the node fetches them no more',
        );
        assert.equal(
            (await journal(far.root)).length,
            0,
            'a follow standing is no road back while the block stands',
        );
        assert.ok(farPost);
    });

    it("lifts the refusal when the administrator overrules it, and takes the persona's word again", async function () {
        const add = await j(
            admin.who,
            `api/identity/${admin.root}/private/set/moderation_overrules`,
            {
                element: `persona:${far.root}`,
            },
        );
        assert.ok(add.ok, await add.clone().text());
        const via = await base58(far.who);
        assert.ok(
            await settle(async () => (await profile(reader, far.root, via)) === 200),
            'fetched again once the refusal is lifted',
        );
        await admin.who(
            `api/identity/${admin.root}/private/set/moderation_overrules/${encodeURIComponent(`persona:${far.root}`)}`,
            { method: 'DELETE' },
        );
        await unlist(admin, far.root);
    });

    it("never refuses the node's own users", async function () {
        assert.equal((await view(admin)).administers, true, 'an administrator is told');
        assert.equal((await view(reader)).administers, false);
        const put = await list(admin, reader.root, 'block', 'my own user');
        assert.equal(put.status, 200);
        const made = await j(reader.who, `api/identity/${reader.root}/docs`, {
            title: 'still here',
            body: 'yes',
            format: 'plaintext',
        });
        assert.equal(made.status, 200, "their account is the operator's to remove, not to starve");
        await unlist(admin, reader.root);
    });

    it('refuses to dial a node an administrator blocks, until the block is lifted', async function () {
        const other = await persona('refuseother', HOST_B);
        await other.who(`api/identity/${other.root}/serve`, { method: 'POST' });
        const endpoint = (await (await far.who('api/node')).json()).endpoint_id;
        const via = await base58(far.who);
        const put = await list(admin, endpoint, 'block', 'a node of spam', 'node');
        assert.equal(put.status, 200, await put.clone().text());
        assert.ok(
            await settle(async () => (await profile(reader, other.root, via)) !== 200),
            'nothing comes from the refused node',
        );
        await unlist(admin, endpoint, 'node');
        assert.ok(
            await settle(async () => (await profile(reader, other.root, via)) === 200),
            'and lifting the block lets it through',
        );
    });
});
