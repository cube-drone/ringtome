/*
    Deleting yourself from this node (leaving.rs; Curtis, 2026-11-01: "delete persona" and "delete
    entire account", each warning that deleting yourself from this node can't remove you from the
    network). A persona deleted here is this computer retiring from it - its other computers hear
    the retirement - and the account letting go of it; and it "still allows the user to spin up
    this same persona on this same node": adoption brings it back with a fresh key. An account
    deleted here takes its personas the same way and frees its name. Both ask for the password
    again, only from a browser, and the server's administrator can't delete their own account.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, HOST_B, makeFetch, sql } = require('./fetch.cjs');
const { makeUserFetch, decodeCode } = require('./helpers.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

const keys = async (who, root) => (await (await who(`api/identity/${root}/keys`)).json()).keys;
const roots = async (who) => (await (await who('api/identity')).json()).map((p) => p.root_pubkey);

/// Bring `root` (held by `granter`) to `joiner`'s node; the joiner's new key.
async function adopt(granter, joiner, root) {
    const request = await (await joiner('api/identity/adopt/begin', { method: 'POST' })).json();
    const leaf = decodeCode(request.code).leaf_pubkey;
    const grant = await (
        await j(granter, `api/identity/${root}/nodes`, { code: request.code })
    ).json();
    const done = await j(joiner, 'api/identity/adopt/complete', { code: grant.code });
    assert.equal(done.status, 200, await done.clone().text());
    return leaf;
}

/// Wait until `who` sees `leaf` in `root`'s tree with `status`.
async function seesKey(who, root, leaf, status) {
    for (let i = 0; i < 60; i++) {
        const k = (await keys(who, root)).find((x) => x.pubkey === leaf);
        if (k && k.status === status) return;
        await sleep(500);
    }
    assert.fail(`${leaf.slice(0, 8)} never read as ${status}`);
}

describe('deleting yourself from this node', function () {
    this.timeout(180000);

    it('asks for the password again, and only from a browser', async function () {
        const me = await makeUserFetch({ prefix: 'leavepw' });
        const root = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
        const wrong = await j(me, `api/identity/${root}/delete`, { password: 'not-it' });
        assert.equal(wrong.status, 401, 'a wrong password deletes nothing');
        assert.deepEqual(await roots(me), [root], 'the persona is still here');

        const made = await (await j(me, 'api/auth/keys', { name: 'a program' })).json();
        const bare = makeFetch();
        const program = (path, opts = {}) =>
            bare(path, {
                ...opts,
                headers: { ...(opts.headers || {}), Authorization: `Bearer ${made.key}` },
            });
        const keyed = await j(program, `api/identity/${root}/delete`, { password: me.password });
        assert.equal(keyed.status, 403, 'an API key deletes nothing, even with the password');
        assert.equal(
            (await j(program, 'api/auth/delete-account', { password: me.password })).status,
            403,
        );
        assert.deepEqual(await roots(me), [root]);
    });

    it("says when this is the persona's only computer", async function () {
        const me = await makeUserFetch({ prefix: 'leaveonly' });
        const root = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
        const leaving = await (await me(`api/identity/${root}/leaving`)).json();
        assert.equal(leaving.other_computers, 0, 'its spare key is no computer');
    });

    it("won't delete the account of the server's administrator", async function () {
        const admin = await makeUserFetch({ prefix: 'leaveadmin' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
            HOST,
        );
        const r = await j(admin, 'api/auth/delete-account', { password: admin.password });
        assert.equal(r.status, 400, await r.clone().text());
        assert.equal((await admin('api/auth/whoami')).status, 200, 'still signed in');
    });
});

(HOST_B ? describe : describe.skip)('deleting yourself from one of two computers', function () {
    this.timeout(300000);

    let alice, aliceOnB, anew, root, leafB;

    before(async () => {
        alice = await makeUserFetch({ prefix: 'leavea' });
        root = (await (await alice('api/identity', { method: 'POST' })).json()).root_pubkey;
        aliceOnB = await makeUserFetch({ prefix: 'leaveb', host: HOST_B });
        leafB = await adopt(alice, aliceOnB, root);
    });

    it('counts the other computer before anything is deleted', async function () {
        const leaving = await (await aliceOnB(`api/identity/${root}/leaving`)).json();
        assert.equal(leaving.other_computers, 1, 'the computer it was adopted from');
    });

    it("deleting the persona retires this computer's key, and the other computer hears", async function () {
        const r = await j(aliceOnB, `api/identity/${root}/delete`, { password: aliceOnB.password });
        assert.equal(r.status, 200, await r.clone().text());
        const said = await r.json();
        assert.equal(said.tried, 1);
        assert.equal(said.told, 1, 'the retirement reached the other computer');
        assert.deepEqual(await roots(aliceOnB), [], 'the account let go of it');
        assert.equal((await aliceOnB(`api/identity/${root}/keys`)).status, 404);
        await seesKey(alice, root, leafB, 'retired');
        // The persona carries on where it still lives.
        const note = await j(alice, `api/identity/${root}/docs`, {
            title: 'still here',
            body: 'yes',
            format: 'marquee',
        });
        assert.equal(note.status, 200, await note.clone().text());
    });

    it('comes back to the same computer by adoption, with a fresh key, and writes again', async function () {
        const again = await adopt(alice, aliceOnB, root);
        assert.notEqual(again, leafB, 'a fresh key; the retired one never speaks again');
        assert.deepEqual(await roots(aliceOnB), [root]);
        const note = await j(aliceOnB, `api/identity/${root}/docs`, {
            title: 'back again',
            body: 'hello',
            format: 'marquee',
        });
        assert.equal(note.status, 200, await note.clone().text());
        await seesKey(alice, root, again, 'active');
        leafB = again;
    });

    it('deleting the account retires its personas here, frees its name, and ends its session', async function () {
        const r = await j(aliceOnB, 'api/auth/delete-account', { password: aliceOnB.password });
        assert.equal(r.status, 200, await r.clone().text());
        assert.deepEqual((await r.json()).personas, [root]);
        assert.equal((await aliceOnB('api/auth/whoami')).status, 401, 'the session went with it');
        await seesKey(alice, root, leafB, 'retired');

        const login = await makeFetch(HOST_B)('api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username: aliceOnB.username, password: aliceOnB.password }),
        });
        assert.equal(login.status, 401, 'the account is gone');
        // Its name is free, and a new account under it can bring the persona back once more.
        anew = await makeUserFetch({ username: aliceOnB.username, host: HOST_B });
        await adopt(alice, anew, root);
        assert.deepEqual(await roots(anew), [root]);
    });

    it('deleted from the computer it was founded on, it carries on from the other, and comes back', async function () {
        // Here the retiring key is the root itself; the other computer goes on as its child.
        const r = await j(alice, `api/identity/${root}/delete`, { password: alice.password });
        assert.equal(r.status, 200, await r.clone().text());
        assert.equal((await r.json()).told, 1);
        assert.deepEqual(await roots(alice), []);
        await seesKey(anew, root, root, 'retired');
        const note = await j(anew, `api/identity/${root}/docs`, {
            title: 'carrying on',
            body: 'yes',
            format: 'marquee',
        });
        assert.equal(note.status, 200, await note.clone().text());

        // Back to the founding computer, granted from the other.
        const back = await adopt(anew, alice, root);
        assert.deepEqual(await roots(alice), [root]);
        const written = await j(alice, `api/identity/${root}/docs`, {
            title: 'home again',
            body: 'hi',
            format: 'marquee',
        });
        assert.equal(written.status, 200, await written.clone().text());
        await seesKey(anew, root, back, 'active');
    });
});
