const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeFetch, sql, HOST } = require('./fetch.cjs');

// Unique username per run so repeated test runs against a persistent node don't collide.
function uniqueUsername() {
    return 'user_' + Math.random().toString(36).slice(2, 10);
}

async function register(fetch, username, password) {
    return fetch('api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
    });
}

// A rename reaches the byline cache a beat after the save (fanout.rs refreshes it on the public
// move), and sign-in by display name reads that cache: ask again until it answers.
async function until200(ask, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
        const resp = await ask();
        if (resp.status === 200 || Date.now() > end) return resp;
        await new Promise((r) => setTimeout(r, 200));
    }
}

async function login(fetch, username, password) {
    return fetch('api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
    });
}

describe('auth', function () {
    it('registers, logs in, identifies, and logs out', async function () {
        const fetch = makeFetch(); // fresh cookie jar
        const username = uniqueUsername();
        const password = 'correct horse battery staple';

        // Register.
        let resp = await register(fetch, username, password);
        assert.equal(resp.status, 200, 'register should succeed');
        let body = await resp.json();
        assert.equal(body.username, username);

        // Before login, whoami is unauthorized.
        resp = await fetch('api/auth/whoami');
        assert.equal(resp.status, 401, 'whoami should be 401 before login');

        // Log in (sets the session cookie in the jar).
        resp = await login(fetch, username, password);
        assert.equal(resp.status, 200, 'login should succeed');

        // whoami now works and returns the right account.
        resp = await fetch('api/auth/whoami');
        assert.equal(resp.status, 200, 'whoami should be 200 after login');
        body = await resp.json();
        assert.equal(body.username, username);

        // Log out.
        resp = await fetch('api/auth/logout', { method: 'POST' });
        assert.equal(resp.status, 200, 'logout should succeed');

        // whoami is unauthorized again (session revoked server-side).
        resp = await fetch('api/auth/whoami');
        assert.equal(resp.status, 401, 'whoami should be 401 after logout');
    });

    it('keeps the session cookie as long as the session - it outlives the app that set it (2026-10-01)', async function () {
        // A cookie with no Max-Age dies with the browser process; the desktop app's webview drops it
        // at every relaunch, and every update relaunches it (Curtis: "it logs me out").
        const fetch = makeFetch();
        const username = uniqueUsername();
        await register(fetch, username, 'correct horse battery staple');
        const resp = await login(fetch, username, 'correct horse battery staple');
        assert.equal(resp.status, 200);
        const cookie = resp.headers.get('set-cookie') || '';
        assert.match(cookie, /ringtome_session_\d+=/, cookie);
        assert.match(cookie, /Max-Age=2592000/, `thirty days, the server's own: ${cookie}`);
    });

    it('slides a session in use out to thirty days again, at most once a day, and sends the cookie anew', async function () {
        // Curtis, 2026-10-01: logged out every thirty days however much the app was used.
        const fetch = makeFetch();
        const username = uniqueUsername();
        await register(fetch, username, 'correct horse battery staple');
        const cookie =
            (await login(fetch, username, 'correct horse battery staple')).headers.get(
                'set-cookie',
            ) || '';
        const token = (cookie.match(/ringtome_session_\d+=([0-9a-f]+)/) || [])[1];
        assert.ok(token, cookie);
        const DAY = 24 * 3600 * 1000;
        const expiry = async () =>
            Number(
                (await sql(`SELECT expires_at_ms FROM sessions WHERE token = '${token}'`, HOST))
                    .rows[0].expires_at_ms,
            );

        let resp = await fetch('api/auth/whoami');
        assert.equal(
            resp.headers.get('set-cookie'),
            null,
            'a session just made is fresh: nothing to renew',
        );

        // Five days left, as if it were made twenty-five days ago.
        await sql(
            `UPDATE sessions SET expires_at_ms = ${Date.now() + 5 * DAY} WHERE token = '${token}'`,
            HOST,
        );
        resp = await fetch('api/auth/whoami');
        assert.equal(resp.status, 200);
        assert.match(
            resp.headers.get('set-cookie') || '',
            /Max-Age=2592000/,
            'used, it renews - and says so to the browser',
        );
        assert.ok((await expiry()) > Date.now() + 29 * DAY, 'thirty days from now again');

        resp = await fetch('api/auth/whoami');
        assert.equal(resp.headers.get('set-cookie'), null, 'and not again the same day');

        resp = await fetch('api/auth/logout', { method: 'POST' });
        assert.equal(resp.status, 200);
        assert.equal((await fetch('api/auth/whoami')).status, 401, 'a logout still ends it');
    });

    it('rejects wrong passwords and duplicate usernames', async function () {
        const fetch = makeFetch();
        const username = uniqueUsername();
        const password = 'a-good-password';

        assert.equal((await register(fetch, username, password)).status, 200);

        // Duplicate username.
        const dup = await register(fetch, username, 'another-password');
        assert.equal(dup.status, 400, 'duplicate username should be rejected');

        // Wrong password.
        const bad = await login(fetch, username, 'wrong-password');
        assert.equal(bad.status, 401, 'wrong password should be 401');

        // Nonexistent user (same 401 - no user enumeration).
        const missing = await login(fetch, uniqueUsername(), 'whatever');
        assert.equal(missing.status, 401, 'nonexistent user should be 401');
    });

    it("signs in by a persona's display name, its words or its key, and refuses a name two accounts share (2026-10-20)", async function () {
        // The account's own name is the easiest thing to forget, so sign-in and spare-key recovery
        // take the names its personas go by (auth.rs `account_for_sign_in`).
        const { speakable } = await import('../../js/speakable.js');
        const password = 'a-good-password';
        const make = async (name) => {
            const fetch = makeFetch();
            const username = uniqueUsername();
            assert.equal((await register(fetch, username, password)).status, 200);
            assert.equal((await login(fetch, username, password)).status, 200);
            const { root_pubkey: root } = await (
                await fetch('api/identity', { method: 'POST' })
            ).json();
            const set = await fetch(`api/identity/${root}/profile`, {
                method: 'POST',
                body: JSON.stringify({ field: 'name', value: name }),
            });
            assert.equal(set.status, 200, 'naming the persona');
            return { username, root };
        };
        const tag = Math.random().toString(36).slice(2, 8);
        const solo = await make(`Solo Sal ${tag}`);
        const signsInAs = async (typed, why) => {
            const fetch = makeFetch();
            const resp = await until200(() => login(fetch, typed, password));
            assert.equal(resp.status, 200, `${why}: ${await resp.text()}`);
            assert.equal(
                (await (await fetch('api/auth/whoami')).json()).username,
                solo.username,
                why,
            );
        };
        const words = speakable(solo.root).split('-').slice(0, 2);
        await signsInAs(`solo sal ${tag}`, 'the display name, case aside');
        await signsInAs(words.join('-'), 'the two speakable words');
        await signsInAs(words.join(' '), 'the words with a space');
        await signsInAs(speakable(solo.root), 'the whole address');
        await signsInAs(speakable(solo.root).split('-')[2], 'the bare key');
        await signsInAs(solo.root, 'the key in hex');

        // A wrong password is still the uniform 401, whichever name found the account.
        assert.equal((await login(makeFetch(), `Solo Sal ${tag}`, 'nope-nope')).status, 401);

        // Two accounts whose personas share a name: refused, saying why.
        await make(`Common Mike ${tag}`);
        await make(`Common Mike ${tag}`);
        // Until both names reach the byline cache, the name means one account or none.
        const end = Date.now() + 15000;
        let twice = await login(makeFetch(), `Common Mike ${tag}`, password);
        while (twice.status !== 400 && Date.now() < end) {
            await new Promise((r) => setTimeout(r, 200));
            twice = await login(makeFetch(), `Common Mike ${tag}`, password);
        }
        assert.equal(twice.status, 400, 'a name two accounts answer to is ambiguous');
        assert.match(await twice.text(), /more than one person here goes by that name/);
    });

    it('on a development build, makes the asker a node_admin - never from an API key (2026-10-20)', async function () {
        // The rig runs a development build, as Developer Options' "make me a node_admin" needs.
        const fetch = makeFetch();
        const username = uniqueUsername();
        await register(fetch, username, 'correct horse battery staple');
        await login(fetch, username, 'correct horse battery staple');
        assert.equal((await fetch('api/admin/node/ping')).status, 403, 'not an administrator yet');

        const made = await fetch('api/auth/dev/node-admin', { method: 'POST' });
        assert.equal(made.status, 200, await made.clone().text());
        assert.ok((await made.json()).tags.includes('node_admin'), 'the answer carries the tag');
        assert.equal((await fetch('api/admin/node/ping')).status, 200, 'and it holds');

        const other = makeFetch();
        const otherName = uniqueUsername();
        await register(other, otherName, 'correct horse battery staple');
        await login(other, otherName, 'correct horse battery staple');
        const { key } = await (
            await other('api/auth/keys', {
                method: 'POST',
                body: JSON.stringify({ name: 'a script' }),
            })
        ).json();
        const byKey = await makeFetch()('api/auth/dev/node-admin', {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
        });
        assert.equal(byKey.status, 403, 'a program never makes its account an administrator');
        assert.equal((await other('api/admin/node/ping')).status, 403);
    });

    it('allows short PINs on a loopback node, rejects only empty', async function () {
        // The integration node binds 127.0.0.1, so the password floor relaxes to a PIN:
        // reaching this login prompt already required being at the machine
        // (Config::password_min_len - a public bind keeps the 8-character floor, which the
        // Rust unit test covers since this harness has no network-facing node).
        const fetch = makeFetch();
        const pin = await register(fetch, uniqueUsername(), '1234');
        assert.equal(pin.status, 200, 'a PIN is an honest posture on a local device');
        const empty = await register(fetch, uniqueUsername(), '');
        assert.equal(empty.status, 400, 'empty is confusion, not a posture');
    });

    /*
        A cross-site caller is nobody here (DESKTOP.md, Stage 3). `SameSite=Lax` keeps the
        session cookie off a cross-site `fetch`, but it deliberately SENDS it on a cross-site
        top-level GET navigation - which a page on the open web can perform on itself, at a
        door of its choosing, and bounce back from. Two of this node's GET doors have side
        effects (a foreign profile fetch dials the endpoints its query names; entering a room
        joins it), so the browser's own label is read and the session ignored. Anonymous, not
        refused: the public surfaces still answer, because a stranger arriving from another
        site is exactly an anonymous caller.
    */
    it('treats a cross-site request as anonymous, and keeps the public doors open to it', async function () {
        const fetch = makeFetch();
        const username = uniqueUsername();
        const password = 'correct horse battery staple';
        assert.equal((await register(fetch, username, password)).status, 200);
        assert.equal((await login(fetch, username, password)).status, 200);

        const whoami = await fetch('api/auth/whoami');
        assert.equal(whoami.status, 200, 'the cookie works, as it always has');

        const crossSite = await fetch('api/auth/whoami', {
            headers: { 'Sec-Fetch-Site': 'cross-site' },
        });
        assert.equal(crossSite.status, 401, 'the same cookie, labelled cross-site, is nobody');

        const sameOrigin = await fetch('api/auth/whoami', {
            headers: { 'Sec-Fetch-Site': 'same-origin' },
        });
        assert.equal(sameOrigin.status, 200, 'our own page is unaffected');

        const publicDoor = await fetch('api/node/personas', {
            headers: { 'Sec-Fetch-Site': 'cross-site' },
        });
        assert.equal(
            publicDoor.status,
            200,
            'and a public door answers anonymously rather than erroring',
        );
    });
});
