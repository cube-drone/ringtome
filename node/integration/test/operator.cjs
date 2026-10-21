/*
    The operator's sign-up tools (Curtis, 2026-10-02), beside the registration mode in the Server app
    (registration.rs, groups.rs, starters.rs):

    - a limit on how many accounts this node holds, and a disk-use percentage past which it takes
      no more - both refuse at the one door that makes accounts;
    - a sign-up group (2026-10-20): a real group the administrator owns, which every persona made
      here joins, whatever the sign-up mode, through its owner's invite. Personas that were here
      before are not in it;
    - an auto-follow list: whom every persona made here begins knowing, with the dials chosen.

    These change the node for everyone, so every claim puts things back as it found them.
*/
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeUserFetch } = require('./helpers.cjs');
const { makeFetch, sql } = require('./fetch.cjs');

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const j = (who, p, body, method = 'POST') => who(p, { method, body: JSON.stringify(body) });
const name = (tag) => `op${tag}${crypto.randomBytes(3).toString('hex')}`;
const PASSWORD = 'an-invitation-123';

async function nodeAdmin(prefix) {
    const user = await makeUserFetch({ prefix });
    await sql(
        `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${user.account.id}', 'node_admin')`,
    );
    return user;
}

/// Sign up (offering the sign-up password, if any) and sign in, as a fresh browser would.
async function joiner(tag, offered) {
    const username = name(tag);
    const who = makeFetch();
    const r = await j(who, 'api/auth/register', {
        username,
        password: 'password-123',
        registration_password: offered || null,
    });
    if (r.status !== 200) return { status: r.status };
    await j(who, 'api/auth/login', { username, password: 'password-123' });
    const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
    return { status: 200, who, root };
}

/// `me`'s facts about `them`, as `{ trust, interest, tags }` - waiting out the detached starter writes.
async function facts(who, me, them, until = () => true) {
    let out = {};
    for (let i = 0; i < 40; i++) {
        const values =
            (await (await who(`api/identity/${me}/private/kv/contact:${them}`)).json()).values ||
            [];
        const get = (k) => (values.find((v) => v.key === k) || {}).value;
        out = {
            trust: get('trust'),
            interest: get('interest'),
            tags: JSON.parse(get('tags') || '[]'),
        };
        if (until(out)) break;
        await wait(250);
    }
    return out;
}

describe("the operator's sign-up tools", function () {
    this.timeout(120000);
    let admin, adminRoot;
    const limits = (body) => j(admin, 'api/admin/registration/limits', body, 'PUT');
    const mode = (m, password) => j(admin, 'api/admin/registration', { mode: m, password }, 'PUT');

    before(async () => {
        admin = await nodeAdmin('opadm');
        adminRoot = (await (await admin('api/identity', { method: 'POST' })).json()).root_pubkey;
    });
    after(async () => {
        await limits({});
        await mode('open');
    });

    it('are for node administrators only', async () => {
        const plain = await makeUserFetch({ prefix: 'opplain' });
        assert.equal((await j(plain, 'api/admin/registration/limits', {}, 'PUT')).status, 403);
        assert.equal((await j(plain, 'api/admin/auto-follow', { address: adminRoot })).status, 403);
    });

    it("stop sign-ups at the account limit, and again when the limit is lifted they don't", async () => {
        const status = await (await admin('api/admin/registration')).json();
        assert.ok(status.accounts > 0, 'the status says how many accounts there are');
        try {
            assert.equal((await limits({ max_accounts: status.accounts })).status, 200);
            assert.equal((await joiner('full')).status, 403, 'at the limit, nobody new');
        } finally {
            await limits({});
        }
        assert.equal((await joiner('roomy')).status, 200, 'the limit lifted, somebody new');
    });

    it('stop sign-ups when the disk is fuller than the operator allows', async () => {
        const status = await (await admin('api/admin/registration')).json();
        assert.ok(
            status.disk_used_pct > 0,
            `the status says how full the disk is: ${status.disk_used_pct}`,
        );
        try {
            await limits({ disk_max_pct: 1 });
            assert.equal((await joiner('disk')).status, 403, 'any real disk is fuller than 1%');
            await limits({ disk_max_pct: 100 });
            assert.equal((await joiner('disk2')).status, 200, 'and none is past 100%');
        } finally {
            await limits({});
        }
    });

    it("a sign-up group: every persona made here joins the administrator's group, by its owner's invite (2026-10-20)", async () => {
        const before = await joiner('before'); // here before the group: never in it
        const founded = await j(admin, `api/identity/${adminRoot}/groups`, { name: 'Beans Group' });
        assert.equal(founded.status, 200, 'the administrator founds a group');
        const group = (await founded.json()).group;
        const choose = (body) => j(admin, 'api/admin/registration/group', body, 'PUT');
        const status = await (await admin('api/admin/registration')).json();
        assert.ok(
            status.signup_group_choices.some((c) => c.group === group && c.owner === adminRoot),
            `the group is among the administrator's choices: ${JSON.stringify(status.signup_group_choices)}`,
        );
        assert.equal(
            (await choose({ group, owner: before.root })).status,
            400,
            "only an owner who is one of the administrator's own personas can invite",
        );
        const plain = await makeUserFetch({ prefix: 'opplaingroup' });
        assert.equal(
            (await j(plain, 'api/admin/registration/group', { group, owner: adminRoot }, 'PUT'))
                .status,
            403,
            'and only an administrator chooses',
        );
        const chosen = await choose({ group, owner: adminRoot });
        assert.equal(chosen.status, 200);
        assert.equal((await chosen.json()).owner_owns, true);
        const memberOf = async (who, me, them, want = true) => {
            let roster = {};
            for (let i = 0; i < 40; i++) {
                const r = await who(`api/identity/${me}/groups/${group}`);
                roster = r.status === 200 ? await r.json() : {};
                const has = (roster.members || []).some((m) => m.root === them);
                if (has === want) return true;
                await wait(250);
            }
            return false;
        };
        try {
            const front = await (await makeFetch()('api/registration')).json();
            assert.equal(front.group, 'Beans Group', 'the sign-up form names the group first');
            const ada = await joiner('ada'); // open sign-ups: any mode joins
            assert.equal(ada.status, 200);
            assert.ok(await memberOf(ada.who, ada.root, ada.root), "ada's own node counts her in");
            assert.ok(await memberOf(admin, adminRoot, ada.root), "and so does the owner's");
            const second = (await (await ada.who('api/identity', { method: 'POST' })).json())
                .root_pubkey;
            assert.ok(
                await memberOf(admin, adminRoot, second),
                'every new persona joins, not only the first',
            );
            assert.ok(
                await memberOf(admin, adminRoot, before.root, false),
                'a persona from before the group is not in it',
            );
            await mode('password', PASSWORD);
            const bea = await joiner('bea', PASSWORD);
            assert.ok(await memberOf(admin, adminRoot, bea.root), 'a password sign-up joins too');
        } finally {
            await mode('open');
            assert.equal((await choose({})).status, 200, 'no group');
        }
        assert.equal(
            (await (await makeFetch()('api/registration')).json()).group,
            null,
            'and the form says none',
        );
        const cee = await joiner('cee');
        assert.ok(
            await memberOf(admin, adminRoot, cee.root, false),
            'with none chosen, nobody joins',
        );
    });

    it('an auto-follow list: every persona made here begins knowing whom the operator chose', async () => {
        const star = (await (await admin('api/identity', { method: 'POST' })).json()).root_pubkey;
        const { toBase58 } = await import('../../js/speakable.js');
        const list = await (
            await j(admin, 'api/admin/auto-follow', {
                address: `https://example.org/ringtome/user/${toBase58(star)}?via=abc`,
                trust: 'medium',
            })
        ).json();
        const mine = list.find((a) => a.root === star);
        assert.ok(mine, `listed: ${JSON.stringify(list)}`);
        assert.deepEqual(
            [mine.trust, mine.interest, mine.rebroadcasts, mine.via],
            ['medium', 'medium', 'low', ['abc']],
            'the chosen dial, the defaults, the hint',
        );
        try {
            const newcomer = await joiner('auto');
            const f = await facts(newcomer.who, newcomer.root, star, (x) => x.trust);
            assert.deepEqual(
                [f.trust, f.interest],
                ['medium', 'medium'],
                'the newcomer begins knowing them',
            );
        } finally {
            const left = await (
                await admin(`api/admin/auto-follow/${star}`, { method: 'DELETE' })
            ).json();
            assert.ok(!left.some((a) => a.root === star), 'and off the list again');
        }
    });
});
