/*
    The operator's sign-up tools (Curtis, 2026-10-02), beside the registration mode in the Server app
    (registration.rs, groups.rs, starters.rs):

    - a limit on how many accounts this node holds, and a disk-use percentage past which it takes
      no more - both refuse at the one door that makes accounts;
    - a group: while sign-ups take a password, a newcomer's first persona joins it - low trust and
      low interest, both ways, with every other member and every administrator, each tagged with
      the group's name. Accounts that were here before are not in it;
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

/// `me`'s facts about `them`, as `{ trust, interest, tags }` - waiting out the detached group writes.
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

    it('a group server: a password sign-up joins the group, both ways, with every member and the administrator', async () => {
        const before = await joiner('before'); // here before the group: never in it
        try {
            await mode('password', PASSWORD);
            assert.equal((await limits({ group_name: 'Beans Group' })).status, 200);
            const ada = await joiner('ada', PASSWORD);
            const bea = await joiner('bea', PASSWORD);
            assert.equal(ada.status, 200);
            assert.equal(bea.status, 200);
            const inGroup = (f) =>
                f.trust === 'low' && f.interest === 'low' && f.tags.includes('beans group');
            for (const [who, me, them, label] of [
                [bea.who, bea.root, ada.root, 'the later joiner knows the earlier'],
                [ada.who, ada.root, bea.root, 'and the earlier, the later - both ways'],
                [bea.who, bea.root, adminRoot, 'a joiner knows the administrator'],
                [admin, adminRoot, bea.root, 'and the administrator, the joiner'],
            ]) {
                const f = await facts(who, me, them, inGroup);
                assert.ok(inGroup(f), `${label}: ${JSON.stringify(f)}`);
            }
            const outsider = await facts(bea.who, bea.root, before.root);
            assert.equal(
                outsider.trust,
                undefined,
                'an account from before the group is not in it',
            );
            // A second persona is not a member - only an account's first is.
            const second = (await (await bea.who('api/identity', { method: 'POST' })).json())
                .root_pubkey;
            const cee = await joiner('cee', PASSWORD);
            await facts(cee.who, cee.root, bea.root, inGroup);
            assert.equal(
                (await facts(cee.who, cee.root, second)).trust,
                undefined,
                'a second persona is not paired',
            );
        } finally {
            await limits({});
            await mode('open');
        }
        // No group without a password: an open sign-up joins nothing even with a name set.
        await limits({ group_name: 'Beans Group' });
        try {
            const open = await joiner('open');
            assert.equal(
                (await facts(open.who, open.root, adminRoot)).trust,
                undefined,
                'open sign-ups join no group',
            );
        } finally {
            await limits({});
        }
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
