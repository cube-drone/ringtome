/*
    Choosing a persona's look (Curtis, 2026-11-21): making a persona starts with a candidate to
    look at - its colour, picture and words are all drawn from its root key - and another roll
    for as long as it doesn't suit. The node holds a candidate in memory and nowhere else; the
    one kept is named when the persona is made, and is the persona made.
*/
const assert = require('node:assert');

const { makeUserFetch } = require('./helpers.cjs');

const j = (who, p, body) => who(p, { method: 'POST', body: JSON.stringify(body) });

describe("choosing a persona's look", function () {
    this.timeout(60000);

    let ada;
    const roll = async (who = ada) =>
        (await (await who('api/identity/roll', { method: 'POST' })).json()).root_pubkey;
    const personas = async () =>
        (await (await ada('api/identity')).json()).map((p) => p.root_pubkey);

    before(async () => {
        ada = await makeUserFetch({ prefix: 'lookada' });
    });

    it('a roll is a root to look at, and makes nobody', async () => {
        const first = await roll();
        assert.match(first, /^[0-9a-f]{64}$/);
        const second = await roll();
        assert.notEqual(second, first, 'another roll, another key - so another look');
        assert.deepEqual(await personas(), [], 'looking made no persona');
    });

    it('the one kept is the persona made; the ones rolled past are gone', async () => {
        const passed = await roll();
        const kept = await roll();

        const stale = await j(ada, 'api/identity', { root_pubkey: passed });
        assert.equal(stale.status, 400, 'a look rolled past is no longer on offer');
        assert.deepEqual(await personas(), [], 'and nobody was made in its place');

        const made = await j(ada, 'api/identity', { root_pubkey: kept });
        const said = await made.text();
        assert.equal(made.status, 200, said);
        const born = JSON.parse(said);
        assert.equal(born.root_pubkey, kept, 'the persona is the one they were shown');
        assert.match(born.recovery_secret, /^[0-9a-f]{64}$/, 'with its spare key, as ever');
        assert.deepEqual(await personas(), [kept]);

        const again = await j(ada, 'api/identity', { root_pubkey: kept });
        assert.equal(again.status, 400, 'a look is made real once');
    });

    it("one account's look is not another's to keep", async () => {
        const bea = await makeUserFetch({ prefix: 'lookbea' });
        const hers = await roll(bea);
        const taken = await j(ada, 'api/identity', { root_pubkey: hers });
        assert.equal(taken.status, 400);
        const made = await j(bea, 'api/identity', { root_pubkey: hers });
        assert.equal(made.status, 200, 'and it is still hers');
    });

    it('asking for a persona without a look still makes one, of a fresh key', async () => {
        const made = await ada('api/identity', { method: 'POST' });
        assert.equal(made.status, 200);
        assert.equal((await personas()).length, 2);
    });
});
