/*
    Front matter (frontmatter.rs; Curtis, 2026-11-01): an account is made only by agreeing to the
    Terms of Service, the Privacy Policy and the License, and the version agreed to is recorded. The
    three are pages on every node - `/tos`, `/privacy`, `/eula` - the application's words, then every
    server's default, then this server's own additions: a note the operator published, appended and
    never in place of the rest, every version listed at the end of the page, dated, as a diff.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, makeFetch, sql } = require('./fetch.cjs');
const { makeUserFetch, uniqueUsername } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const page = async (path) => {
    const r = await makeFetch()(path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type'), /text\/html/);
    return r.text();
};
const agreedVersions = async (account) =>
    (await sql(`SELECT version FROM terms_agreed WHERE account_id = '${account}'`, HOST)).rows;

describe('front matter: terms, privacy, license', function () {
    this.timeout(120000);

    let admin, root;

    before(async () => {
        admin = await makeUserFetch({ prefix: 'frontadmin' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
            HOST,
        );
        root = (await (await admin('api/identity', { method: 'POST' })).json()).root_pubkey;
    });

    it('makes an account only for someone who agreed, and records what they agreed to', async function () {
        const bare = makeFetch();
        const username = uniqueUsername('frontno');
        const refused = await j(bare, 'api/auth/register', {
            username,
            password: 'test-password-123',
        });
        assert.equal(refused.status, 400, 'no agreement, no account');
        const login = await j(bare, 'api/auth/login', { username, password: 'test-password-123' });
        assert.equal(login.status, 401, 'and none was made');

        const me = await makeUserFetch({ prefix: 'frontyes' });
        const rows = await agreedVersions(me.account.id);
        assert.equal(rows.length, 1);
        assert.match(rows[0].version, /^[0-9a-f]{16}$/);
    });

    it("shows the application's words, every server's default, and the license", async function () {
        const tos = await page('tos');
        assert.match(tos, /Horse Drawing Tycoon 2: Terms of Service/);
        assert.match(tos, /This server&#x27;s terms|This server's terms/);
        assert.match(tos, /href="\/privacy"/, 'the three link each other');
        const privacy = await page('privacy');
        assert.match(privacy, /Horse Drawing Tycoon 2: Privacy Policy/);
        assert.match(privacy, /This server&#x27;s privacy|This server's privacy/);
        const eula = await page('eula');
        assert.match(eula, /GNU AFFERO GENERAL PUBLIC LICENSE/);
        assert.match(eula, /github\.com\/cube-drone\/ringtome/, 'the AGPL asks for the source');
    });

    it("adds the operator's note after the rest, and lists each version as a dated diff", async function () {
        const made = await (
            await j(admin, `api/identity/${root}/docs`, {
                title: 'additions',
                body: 'Be kind to horses.',
                format: 'marquee',
            })
        ).json();
        const before = (await agreedVersions(admin.account.id))[0].version;

        const first = await j(admin, 'api/admin/front-matter/tos', { root, doc_id: made.doc_id });
        assert.equal(first.status, 200, await first.clone().text());
        assert.equal((await first.json()).changed, true);
        let tos = await page('tos');
        const at = (s) => tos.indexOf(s);
        assert.ok(
            at('Be kind to horses.') > at('Terms of Service'),
            "after the application's words",
        );
        assert.ok(at('Be kind to horses.') > at('This server'), "and after every server's default");
        assert.match(
            tos,
            /class="add">\+Be kind to horses\.</,
            'its version, as a diff from nothing',
        );

        const again = await j(admin, 'api/admin/front-matter/tos', { root, doc_id: made.doc_id });
        assert.equal((await again.json()).changed, false, 'the same words change nothing');

        const edit = await j(
            admin,
            `api/identity/${root}/docs/${made.doc_id}`,
            {
                title: 'additions',
                body: 'Be kind to horses.\n\nNo ponies after midnight.',
                parents: [made.version],
                format: 'marquee',
            },
            'PUT',
        );
        assert.equal(edit.status, 200, await edit.clone().text());
        const second = await j(admin, 'api/admin/front-matter/tos', { root, doc_id: made.doc_id });
        assert.equal((await second.json()).changed, true);
        tos = await page('tos');
        assert.match(tos, /class="add">\+No ponies after midnight\.</);
        assert.equal((tos.match(/<pre class="diff">/g) || []).length, 2, 'both versions, listed');
        assert.doesNotMatch(await page('privacy'), /No ponies/, 'the privacy page has its own');

        // A new account agrees to the terms as they stand now: a new version.
        const later = await makeUserFetch({ prefix: 'frontlater' });
        assert.notEqual((await agreedVersions(later.account.id))[0].version, before);
    });

    it("shows the operator's contact and jurisdiction on both pages, a line each", async function () {
        const facts = (who, body) => j(who, 'api/admin/front-matter/facts', body, 'PUT');
        const before = (
            await agreedVersions((await makeUserFetch({ prefix: 'frontpre' })).account.id)
        )[0].version;

        const two = await facts(admin, { contact: 'a\nb', jurisdiction: 'BC, Canada' });
        assert.equal(two.status, 400, 'one line each');
        const long = await facts(admin, { contact: 'x'.repeat(201), jurisdiction: '' });
        assert.equal(long.status, 400, 'and short');
        assert.doesNotMatch(await page('tos'), /BC, Canada/, 'a refusal saves neither');

        const set = await facts(admin, {
            contact: ' operator@gooble.email ',
            jurisdiction: 'BC, Canada',
        });
        assert.equal(set.status, 200, await set.clone().text());
        assert.equal((await set.json()).changed, true);
        for (const path of ['tos', 'privacy']) {
            const html = await page(path);
            assert.match(
                html,
                /<a href="mailto:operator@gooble\.email">operator@gooble\.email<\/a>/,
                path,
            );
            assert.match(html, /BC, Canada/, path);
        }
        const view = await (await admin('api/admin/front-matter')).json();
        assert.equal(view.contact, 'operator@gooble.email', 'kept trimmed');
        assert.equal(view.jurisdiction, 'BC, Canada');
        assert.equal(
            (await (await facts(admin, view)).json()).changed,
            false,
            'the same again changes nothing',
        );

        const after = (
            await agreedVersions((await makeUserFetch({ prefix: 'frontpost' })).account.id)
        )[0].version;
        assert.notEqual(after, before, 'they are part of what a person agrees to');

        const someone = await makeUserFetch({ prefix: 'frontfacts' });
        assert.equal((await facts(someone, { contact: 'me', jurisdiction: 'here' })).status, 403);
    });

    it('lets only an administrator publish, and forgets an account with its agreement', async function () {
        const someone = await makeUserFetch({ prefix: 'frontnot' });
        const theirs = (await (await someone('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        const note = await (
            await j(someone, `api/identity/${theirs}/docs`, {
                title: 'mine',
                body: 'All horses are mine.',
                format: 'marquee',
            })
        ).json();
        const r = await j(someone, 'api/admin/front-matter/tos', {
            root: theirs,
            doc_id: note.doc_id,
        });
        assert.equal(r.status, 403);
        assert.doesNotMatch(await page('tos'), /All horses are mine/);
        assert.equal((await someone('api/admin/front-matter')).status, 403);

        const gone = await j(someone, 'api/auth/delete-account', { password: someone.password });
        assert.equal(gone.status, 200, await gone.clone().text());
        assert.equal((await agreedVersions(someone.account.id)).length, 0);
    });
});
