/*
    An account, as a node administrator sees it (Curtis, 2026-10-20; accounts.rs): found from any
    persona it manages, listing them all, with its sign-in switched off and back on, or evicted.

    Switched off, every door in is shut - the session it had, its password, its API keys, its spare
    key - while its personas stay. Evicted, its personas leave this node and the account is gone.
    Neither is done to the administrator's own account or to another administrator's.
*/
const assert = require('node:assert');
const { makeUserFetch } = require('./helpers.cjs');
const { makeFetch, sql } = require('./fetch.cjs');

const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });

async function nodeAdmin(prefix) {
    const user = await makeUserFetch({ prefix });
    await sql(
        `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${user.account.id}', 'node_admin')`,
    );
    return user;
}

const keyed = (k) => {
    const bare = makeFetch();
    return (path, opts = {}) =>
        bare(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${k}` } });
};

const signIn = (username, password) => j(makeFetch(), 'api/auth/login', { username, password });

describe('an account, as a node administrator sees it', function () {
    this.timeout(30000);

    let admin, person, first, second;
    before(async () => {
        admin = await nodeAdmin('acctadmin');
        person = await makeUserFetch({ prefix: 'acctperson' });
        first = await (await person('api/identity', { method: 'POST' })).json();
        second = await (await person('api/identity', { method: 'POST' })).json();
    });

    it('is found from any persona it manages, and lists them all - for an administrator only', async function () {
        const found = await admin(`api/admin/accounts/of/${second.root_pubkey}`);
        assert.equal(found.status, 200, await found.clone().text());
        const view = await found.json();
        assert.equal(view.id, person.account.id);
        assert.equal(view.username, person.username);
        assert.deepEqual(
            view.personas.map((p) => p.root),
            [first.root_pubkey, second.root_pubkey],
        );
        assert.equal(view.sign_in_off_ms, null);
        assert.equal(view.yours, false);
        assert.equal(view.admin, false);

        const byId = await (await admin(`api/admin/accounts/${person.account.id}`)).json();
        assert.deepEqual(byId.personas, view.personas, 'the same page by its id');

        assert.equal((await person(`api/admin/accounts/${person.account.id}`)).status, 403);
        assert.equal((await person(`api/admin/accounts/of/${first.root_pubkey}`)).status, 403);
        assert.equal(
            (await admin(`api/admin/accounts/of/${'ab'.repeat(32)}`)).status,
            404,
            'a persona nobody here manages has no account to show',
        );
    });

    it('switched off, shuts every door in and keeps its personas; switched on, opens them again', async function () {
        const key = (await (await j(person, 'api/auth/keys', { name: 'a script' })).json()).key;
        assert.equal((await keyed(key)('api/auth/whoami')).status, 200);

        const off = await j(admin, `api/admin/accounts/${person.account.id}/sign-in`, {
            on: false,
        });
        assert.equal(off.status, 200, await off.clone().text());
        assert.ok((await off.json()).sign_in_off_ms, 'it says since when');

        assert.equal((await person('api/auth/whoami')).status, 401, 'its session is over');
        const tried = await signIn(person.username, person.password);
        assert.equal(tried.status, 403, 'the right password is told why');
        assert.match(await tried.text(), /switched off signing in/);
        assert.equal(
            (await signIn(person.username, 'not-the-password')).status,
            401,
            'a wrong one learns nothing',
        );
        assert.equal((await keyed(key)('api/auth/whoami')).status, 401, 'its API key is refused');
        const reset = await j(makeFetch(), 'api/auth/recover', {
            username: person.username,
            recovery_secret: first.recovery_secret,
            new_password: 'a-new-password-123',
            new_username: `escaped${Date.now().toString(36)}`,
        });
        assert.equal(reset.status, 403, 'nor does its spare key reopen it or carry a persona out');
        const still = await sql(
            `SELECT COUNT(*) AS n FROM identities WHERE account_id = '${person.account.id}'`,
        );
        assert.equal(Number(still.rows[0].n), 2, 'its personas stay');

        const on = await j(admin, `api/admin/accounts/${person.account.id}/sign-in`, {
            on: true,
        });
        assert.equal((await on.json()).sign_in_off_ms, null);
        assert.equal((await signIn(person.username, person.password)).status, 200);
        assert.equal((await keyed(key)('api/auth/whoami')).status, 200, 'and its key works again');
    });

    it("is not done to the administrator's own account, nor another administrator's", async function () {
        const mine = await j(admin, `api/admin/accounts/${admin.account.id}/sign-in`, {
            on: false,
        });
        assert.equal(mine.status, 400);
        assert.match(await mine.text(), /your own account/);
        assert.equal((await admin(`api/admin/accounts/${admin.account.id}`)).status, 200);
        assert.equal(
            (await (await admin(`api/admin/accounts/${admin.account.id}`)).json()).yours,
            true,
        );

        const other = await nodeAdmin('acctadmin2');
        const theirs = await admin(`api/admin/accounts/${other.account.id}`, {
            method: 'DELETE',
        });
        assert.equal(theirs.status, 400);
        assert.match(await theirs.text(), /administrator status away first/);
        assert.equal((await other('api/auth/whoami')).status, 200, 'and they are untouched');
    });

    it('evicted, its personas leave this node and the account is gone', async function () {
        const out = await admin(`api/admin/accounts/${person.account.id}`, { method: 'DELETE' });
        assert.equal(out.status, 200, await out.clone().text());
        assert.deepEqual(
            (await out.json()).personas.sort(),
            [first.root_pubkey, second.root_pubkey].sort(),
        );

        assert.equal((await admin(`api/admin/accounts/${person.account.id}`)).status, 404);
        assert.equal((await admin(`api/admin/accounts/of/${first.root_pubkey}`)).status, 404);
        assert.equal((await signIn(person.username, person.password)).status, 401);
        const left = await sql(
            `SELECT COUNT(*) AS n FROM identities WHERE root_pubkey IN ('${first.root_pubkey}', '${second.root_pubkey}')`,
        );
        assert.equal(Number(left.rows[0].n), 0, 'this node no longer hosts them');
        const keys = await sql(
            `SELECT COUNT(*) AS n FROM api_keys WHERE account_id = '${person.account.id}'`,
        );
        assert.equal(Number(keys.rows[0].n), 0, 'nor keeps its keys');
    });
});
