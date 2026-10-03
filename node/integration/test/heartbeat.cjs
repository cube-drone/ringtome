/*
    Heartbeats (HORSE_BASED_CURRENCIES.md, Curtis 2026-09-29): one public mark per persona per day in
    which they used the app - the profile's `heartbeat` field, a UTC date, never a time. Sent by the
    node at the day's first signed-in activity, once; seen by a follower's node on the profile and
    in its byline cache, which is what "active today" on a card and the People page's
    recent-activity order read.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { pullAndFold } = require('./beat.cjs');
const { HOST_B, sql } = require('./fetch.cjs');

const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const today = () => new Date().toISOString().slice(0, 10);

describe('heartbeats', function () {
    this.timeout(120000);

    let ada, adaRoot;
    const heartbeat = async () =>
        (await (await ada(`api/identity/${adaRoot}/profile`)).json()).find(
            (f) => f.field === 'heartbeat',
        ) || null;

    before(async () => {
        ada = await makeUserFetch({ prefix: 'beatada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
    });

    it("the day's first signed-in activity sends today's heartbeat - a date, never a time - and only once", async () => {
        let beat = null;
        for (let i = 0; i < 30 && !beat; i++) {
            beat = await heartbeat();
            if (!beat) await wait(200);
        }
        assert.ok(beat, "the persona's own reads rang the heartbeat");
        assert.equal(beat.value, today(), "today's UTC date, and nothing finer");
        // More activity the same day says nothing new.
        for (let i = 0; i < 5; i++) await ada(`api/identity/${adaRoot}/docs`);
        await wait(500);
        const again = await heartbeat();
        assert.equal(
            again.updated_at_ms,
            beat.updated_at_ms,
            'one heartbeat a day, not one a request',
        );
    });

    it("a follower's node sees it on the profile, and in the byline cache the People page sorts by", async function () {
        if (!HOST_B) this.skip();
        const bea = await makeUserFetch({ prefix: 'beatbea', host: HOST_B });
        const beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200)
            this.skip();
        await bea(`api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, {
            method: 'PUT',
            body: JSON.stringify({ value: 'high' }),
        });
        let seen = null;
        for (let i = 0; i < 20 && !seen; i++) {
            await pullAndFold(HOST_B, adaRoot);
            const fields = (await (await bea(`api/id/${adaRoot}/profile`)).json()).fields || [];
            seen = (fields.find((f) => f.field === 'heartbeat') || {}).value || null;
            if (!seen) await wait(300);
        }
        assert.equal(seen, today(), 'the heartbeat travels on the profile');
        const cached = (
            await sql(
                `SELECT last_active FROM persona_profiles WHERE root_pubkey = '${adaRoot}'`,
                HOST_B,
            )
        ).rows;
        assert.equal(
            (cached[0] || {}).last_active,
            today(),
            "and lands in the follower's byline cache",
        );
    });
});
