/*
    Picture entries on moderation lists (plans/SCANNING.md, _Community picture entries_; Curtis,
    2026-11-02): a moderator lists a picture, not its poster - "excise this image from my network".
    The same file acts at the entry's level wherever it is posted; a picture that only fingerprints
    like it is warned about and never more, because a perceptual hash can be collided on purpose.
    A reader takes picture entries from the people they trust to moderate, and can overrule one;
    what the node's administrator blocks, the node refuses to serve. Meta's regression pictures
    (node/tests/pdq).
*/
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, sql, makeFetch } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bridge = (name) => fs.readFileSync(path.join(__dirname, '../../tests/pdq', name));
const persona = async (who) =>
    (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
const fact = (who, root, about, key, value) =>
    j(who, `api/identity/${root}/private/kv/contact:${about}/${key}`, { value }, 'PUT');

describe('picture entries', function () {
    this.timeout(180000);

    let mod, modRoot, rae, raeRoot, ada, adaRoot, original, resized, other;
    const anon = makeFetch();

    // Publish one picture as a post of its own; its public picture's address.
    const posted = async (bytes, title) => {
        const up = await ada(
            `api/identity/${adaRoot}/docs/binary?title=${encodeURIComponent(title)}`,
            { method: 'POST', body: bytes, file: true },
        );
        assert.equal(up.status, 202, await up.clone().text());
        const { doc_id, job_id } = await up.json();
        for (let i = 0; i < 400; i++) {
            const job = (await (await ada(`api/identity/${adaRoot}/ingest`)).json()).find(
                (x) => x.job_id === job_id,
            );
            if (job && job.status === 'done') break;
            assert.ok(!job || job.status !== 'failed', job && job.error);
            await wait(150);
        }
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title,
                body: `![${title}](/api/identity/${adaRoot}/docs/${doc_id}/body/p.avif)\n`,
                format: 'marquee',
            })
        ).json();
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        const post = (await pub.json()).post_id;
        const twin = ((await (await ada(`api/id/${adaRoot}/posts/${post}`)).json()).refs || [])[0];
        assert.ok(twin, 'the post minted a public picture');
        return twin;
    };
    // A picture's address as a post's words carry it, and where the web fetches it.
    const address = (twin) => `/ringtome/user/${adaRoot}/doc/${twin}/body/p.avif`;
    const served = async (twin, part = 'body') =>
        (await anon(`id/${adaRoot}/docs/${twin}/${part}`)).status;

    const verdicts = async (who, root, pictures) => {
        const r = await j(who, `api/identity/${root}/moderation/verdicts`, { pictures });
        assert.equal(r.status, 200, await r.clone().text());
        return (await r.json()).verdicts;
    };
    // The fold lane carries a list's move into what readers take: wait for it.
    const until = async (fn, what) => {
        for (let i = 0; i < 80; i++) {
            if (await fn()) return;
            await wait(250);
        }
        assert.fail(what);
    };

    before(async () => {
        mod = await makeUserFetch({ prefix: 'picmod' });
        modRoot = await persona(mod);
        rae = await makeUserFetch({ prefix: 'picrae' });
        raeRoot = await persona(rae);
        ada = await makeUserFetch({ prefix: 'picada' });
        adaRoot = await persona(ada);
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        // Three posts: a picture, the same picture scaled down and re-saved, and another one. Not
        // bridge-1, which the quarantine claims seal on this node for good.
        original = await posted(bridge('bridge-5-flipx.jpg'), 'a bridge');
        resized = await posted(bridge('bridge-5-flipx-resized-900.jpg'), 'the bridge again');
        other = await posted(bridge('bridge-2-rotate-90.jpg'), 'a bridge, sideways');
        await fact(rae, raeRoot, modRoot, 'moderates', 'yes');
    });

    // Whatever happened, the moderator administers nothing after: a block left behind would
    // refuse this picture to every later run, and the quarantine claims upload it too.
    after(async () => {
        const view = await (await mod(`api/identity/${modRoot}/moderation`)).json();
        for (const m of (view.mine || []).filter((m) => m.kind === 'picture')) {
            await mod(`api/identity/${modRoot}/moderation/picture/${m.target}`, {
                method: 'DELETE',
            });
        }
        await sql(
            `DELETE FROM account_tags WHERE account_id = '${mod.account.id}' AND tag = 'node_admin'`,
            HOST,
        );
    });

    it('asks nothing while the reader takes no picture entries', async function () {
        assert.deepEqual(await verdicts(rae, raeRoot, [address(original), address(resized)]), {});
    });

    it('lists a picture by its address, with its fingerprint, on the public list', async function () {
        const r = await j(mod, `api/identity/${modRoot}/moderation/by-address`, {
            address: `https://example.org/ringtome/user/${adaRoot}/doc/${original}/thumb`,
            level: 'block',
            reason: 'not on my network',
        });
        assert.equal(r.status, 200, await r.clone().text());
        const { hash } = await r.json();
        const mine = (await (await mod(`api/identity/${modRoot}/moderation`)).json()).mine;
        const row = mine.find((m) => m.kind === 'picture' && m.target === hash);
        assert.ok(row, 'on the list, by the hash of the picture itself');
        assert.equal(row.level, 'block');
        assert.match(row.pdq || '', /^[0-9a-f]{64}$/, 'carrying its fingerprint');

        const nowhere = await j(mod, `api/identity/${modRoot}/moderation/by-address`, {
            address: 'https://example.org/cat.png',
            level: 'block',
        });
        assert.equal(nowhere.status, 400, 'an address that is not one of our pictures');
    });

    it('acts at its level on the same file, and only warns about a lookalike', async function () {
        const [a, b, c] = [address(original), address(resized), address(other)];
        let v = {};
        await until(async () => {
            v = await verdicts(rae, raeRoot, [a, b, c]);
            return !!v[a];
        }, "the moderator's entry never reached the reader");
        assert.deepEqual([v[a].level, v[a].near], ['block', false]);
        assert.equal(v[a].reason, 'not on my network');
        assert.ok(v[b], 'the re-saved copy is recognised');
        assert.deepEqual(
            [v[b].level, v[b].near],
            ['warn', true],
            'a block, matched by fingerprint: a warning, never more',
        );
        assert.equal(v[c], undefined, 'another picture is nobody else');
        assert.equal(
            await served(original),
            200,
            "a reader's moderator decides what the reader sees, not what the server serves",
        );
    });

    it('leaves the reader the last word', async function () {
        const hash = (await (await mod(`api/identity/${modRoot}/moderation`)).json()).mine.find(
            (m) => m.kind === 'picture',
        ).target;
        const over = await j(rae, `api/identity/${raeRoot}/private/set/moderation_overrules`, {
            element: `picture:${hash}`,
        });
        assert.ok(over.status < 300, await over.clone().text());
        assert.deepEqual(await verdicts(rae, raeRoot, [address(original), address(resized)]), {});
    });

    it("refuses to serve what the server's administrator blocks", async function () {
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${mod.account.id}', 'node_admin')`,
            HOST,
        );
        // Restated, so the node works out again what its administrators block.
        const hash = (await (await mod(`api/identity/${modRoot}/moderation`)).json()).mine.find(
            (m) => m.kind === 'picture',
        ).target;
        const put = await j(
            mod,
            `api/identity/${modRoot}/moderation/picture/${hash}`,
            { level: 'block', reason: 'not on this server' },
            'PUT',
        );
        assert.equal(put.status, 200, await put.clone().text());
        await until(
            async () => (await served(original)) === 404,
            'the blocked picture is still served',
        );
        assert.equal(await served(original, 'thumb'), 404, 'and its thumbnail with it');
        assert.equal(await served(resized), 200, 'a lookalike is never refused');

        // Taken off again, by `after`, while still an administrator - so the node works its
        // refusals out once more. Lifting undoes the refusal, not the clearing: the reaper may
        // already have let the file go.
    });
});
