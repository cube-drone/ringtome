/*
    A line pushed to somebody who only holds the room (Curtis, 2026-11-22: a public chat its
    creator opened from a phone, the phone off; "As Curtis, I commented on the public Chat ...
    These messages never reached Cube Drone", and never did). A speaker pushes their room chain to
    the creator's node, and the first place they look for it is wherever they first read the
    creator from (`foreign_fetches.last_via`) - which need not be the creator's node at all: cal
    never reached ada's phone, and read her from a node that merely held her. That node is in the
    room, so it takes the push; and the push used to end there, on a bystander nobody asks, with
    the creator dark and the other speakers never told.

    Ada opens a room; bea says a word; eve and cal enter and say nothing. Cal's node is then told
    it first read ada from eve's. Ada's node goes dark, cal speaks, and bea hears it.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C, HOST_E, sql } = require('./fetch.cjs');
const { withUnplugged } = require('./unplug.cjs');

const endpointOf = async (who) => (await (await who('api/node')).json()).endpoint_id;
const base58 = async (who) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58(await endpointOf(who));
};
const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C && HOST_E ? describe : describe.skip)(
    'a line pushed to a node that only holds the room',
    function () {
        this.timeout(600000);

        let ada, adaRoot, bea, beaRoot, cal, calRoot, eve, eveRoot, room;

        const say = async (who, root, words) => {
            const r = await j(who, `api/identity/${root}/rooms/${adaRoot}/${room}/messages`, {
                words,
            });
            assert.equal(r.status, 200, await r.text());
        };
        const wordsOn = async (who, root) =>
            (
                (await (await who(`api/identity/${root}/rooms/${adaRoot}/${room}/messages`)).json())
                    .items || []
            ).map((m) => m.words);
        // The reader's node pulls the room and folds what landed, until it holds `want`.
        const reads = async (host, who, root, want, tries = 30) => {
            let words = [];
            for (let i = 0; i < tries; i++) {
                await who(`api/identity/${root}/rooms/${adaRoot}/${room}/sync`, { method: 'POST' });
                for (const speaker of [adaRoot, beaRoot, calRoot])
                    await beat(host, 'fold', speaker);
                words = await wordsOn(who, root);
                if (words.includes(want)) break;
                await wait(400);
            }
            return words;
        };
        const enter = async (who, root) => {
            for (let i = 0; i < 30; i++) {
                if ((await who(`api/identity/${root}/rooms/${adaRoot}/${room}`)).status === 200)
                    return true;
                await wait(400);
            }
            return false;
        };
        const person = async (prefix, host) => {
            const who = await makeUserFetch(host ? { prefix, host } : { prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: 'POST' });
            return [who, root];
        };

        before(async function () {
            [ada, adaRoot] = await person('byada');
            [bea, beaRoot] = await person('bybea', HOST_B);
            [cal, calRoot] = await person('bycal', HOST_C);
            [eve, eveRoot] = await person('byeve', HOST_E);

            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'the landing',
                    body: 'sit a while',
                    format: 'marquee',
                })
            ).json();
            await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: 'PUT' });
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
                room: true,
            });
            const text = await pub.text();
            assert.equal(pub.status, 200, text);
            room = JSON.parse(text).post_id;

            const viaAda = await base58(ada);
            for (const [who, root] of [
                [bea, beaRoot],
                [eve, eveRoot],
                [cal, calRoot],
            ]) {
                if ((await who(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200)
                    this.skip();
                assert.ok(await enter(who, root), 'in the room');
            }
            await say(bea, beaRoot, 'bea is here');
            for (const [host, who, root, name] of [
                [HOST_E, eve, eveRoot, 'eve'],
                [HOST_C, cal, calRoot, 'cal'],
            ]) {
                const words = await reads(host, who, root, 'bea is here');
                assert.ok(words.includes('bea is here'), `${name}: ${JSON.stringify(words)}`);
            }
        });

        it("cal, who read ada from eve's node, speaks with ada dark - and bea is told", async () => {
            // As if cal had never reached ada's own node: the place cal's node first looks for
            // her is eve's, which holds the room and is nobody in it.
            const was = await sql(
                `SELECT last_via FROM foreign_fetches WHERE root_pubkey = '${adaRoot}'`,
                HOST_C,
            );
            assert.equal(
                was.rows[0] && was.rows[0].last_via,
                await endpointOf(ada),
                "cal's node read ada from her own node, in the form the node keeps",
            );
            await sql(
                `UPDATE foreign_fetches SET last_via = '${await endpointOf(eve)}' WHERE root_pubkey = '${adaRoot}'`,
                HOST_C,
            );
            await withUnplugged([HOST], async () => {
                await say(cal, calRoot, 'is anyone awake?');
                const onBea = await reads(HOST_B, bea, beaRoot, 'is anyone awake?');
                assert.ok(
                    onBea.includes('is anyone awake?'),
                    `bea hears cal: ${JSON.stringify(onBea)}`,
                );
            });
        });
    },
);
