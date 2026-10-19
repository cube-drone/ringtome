/*
    The crowd's door (plans/CROWD.md, ruling 1, Curtis, 2026-10-11): who a node answers about a
    persona it holds but doesn't host.

    Before this, the sync door served any persona somebody on the node followed or had looked at,
    to anyone who named it - so a stranger probing a household node with a root read out "somebody
    here follows them" for a QUIET follow. Now a stranger is answered when the follow here is
    published, or when the node serves more than ten personas (a crowd to hide one quiet follow
    in); and the persona's own nodes are answered whatever, by member proof, because their push is
    the follow working.

    Ada is on A. Fay, on B, follows her quietly. A stranger node asks B about ada directly
    (`test/door-probe`, one door, one endpoint: the ordinary ladders would race ada's own node
    alongside, which answers whatever B's door does). Every rig node serves dozens of personas by
    the time this runs, so B's bar is raised past them (`test/quiet-crowd`) to make it small.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeFetch, sql, HOST, HOST_B, HOST_C, HOST_E } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

(HOST_B && HOST_C ? describe : describe.skip)(
    'the crowd: who a node answers about a persona it follows',
    function () {
        this.timeout(300000);

        let ada, adaRoot, fay, fayRoot, bEndpoint, stranger;
        const anonB = makeFetch(HOST_B);
        const bar = (n) => j(anonB, 'test/quiet-crowd', { n });
        const probe = async (door) => {
            const res = await j(makeFetch(stranger), 'test/door-probe', {
                root: adaRoot,
                endpoint: bEndpoint,
                door,
            });
            const text = await res.text();
            assert.equal(res.status, 200, text);
            return JSON.parse(text);
        };
        const dial = (key, value) =>
            j(
                fay,
                `api/identity/${fayRoot}/private/kv/contact:${adaRoot}/${key}`,
                { value },
                'PUT',
            );
        const remember = async () => {
            await beat(HOST_B, 'mint', fayRoot);
            await beat(HOST_B, 'fold', fayRoot);
        };
        const publish = async (title) => {
            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title,
                    body: 'hello',
                    format: 'plaintext',
                })
            ).json();
            const pub = await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
                method: 'POST',
            });
            return JSON.parse(await pub.text()).post_id;
        };

        before(async function () {
            ada = await makeUserFetch({ prefix: 'crowdada' });
            adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
            await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
            await publish('Before');
            const { toBase58 } = await import('../../js/speakable.js');
            const viaA = toBase58((await (await ada('api/node')).json()).endpoint_id);

            fay = await makeUserFetch({ prefix: 'crowdfay', host: HOST_B });
            fayRoot = (await (await fay('api/identity', { method: 'POST' })).json()).root_pubkey;
            await fay(`api/identity/${fayRoot}/serve`, { method: 'POST' });
            const first = await fay(`api/id/${adaRoot}/profile?via=${viaA}`);
            assert.equal(first.status, 200, await first.text());
            await dial('interest', 'high');
            await dial('edges_public', 'no');
            await remember();
            await pullAndFold(HOST_B, adaRoot);
            bEndpoint = (await (await fay('api/node')).json()).endpoint_id;

            // A stranger to B: a node none of B's personas has a device on, or the household
            // rule answers it - rightly, and this file would be testing the wrong door.
            const { rows } = await sql('SELECT DISTINCT endpoint_id FROM identity_peers', HOST_B);
            const bKnows = new Set(rows.map((r) => String(r.endpoint_id).toLowerCase()));
            for (const host of [HOST_C, HOST_E].filter(Boolean)) {
                const someone = await makeUserFetch({ prefix: 'crowdstranger', host });
                const ep = (await (await someone('api/node')).json()).endpoint_id;
                if (!bKnows.has(String(ep).toLowerCase())) {
                    stranger = host;
                    break;
                }
            }
            if (!stranger) this.skip();
            assert.equal((await bar(1000000)).status, 200);
        });

        after(async () => {
            await bar(10);
        });

        it('a stranger asking a small node about a persona followed there quietly hears nothing', async () => {
            const { rows } = await sql(
                `SELECT public FROM subscriptions WHERE local_root = '${fayRoot}'
                 AND foreign_root = '${adaRoot}'`,
                HOST_B,
            );
            assert.equal(rows[0]?.public, 0, 'the memo knows the follow is quiet');
            assert.equal(
                (await probe('shelf')).posts,
                0,
                'no shelf: a list of her posts would say somebody here follows her',
            );
            assert.equal(
                (await probe('sync')).received,
                0,
                'no chains: the polite empty exchange, as if nobody here had heard of her',
            );
        });

        it('her own node is still answered: the post she pushes lands in the quiet follow', async () => {
            const post = await publish('After');
            await beat(HOST, 'fold', adaRoot);
            await beat(HOST, 'demand-push', adaRoot);
            await beat(HOST_B, 'fold', adaRoot);
            const { rows } = await sql(
                `SELECT doc_id FROM feed_journal WHERE reader_root = '${fayRoot}'
                 AND author_root = '${adaRoot}'`,
                HOST_B,
            );
            assert.ok(
                rows.some((r) => r.doc_id === post),
                'the push proved itself hers, and the door let it in',
            );
        });

        it('a published follow opens the door: anyone may know it already', async () => {
            await dial('edges_public', 'yes');
            await remember();
            assert.ok((await probe('shelf')).posts > 0, 'the shelf answers now');
            assert.ok((await probe('sync')).received > 0, 'and so do her chains');
        });

        it('so does a crowd: past the bar, "somebody here" could be anyone', async () => {
            await dial('edges_public', 'no');
            await remember();
            assert.equal((await probe('shelf')).posts, 0, 'quiet again, and small: nothing');
            assert.equal((await bar(0)).status, 200);
            assert.ok((await probe('shelf')).posts > 0, 'quiet, but crowded: the shelf answers');
        });
    },
);

/*
    Holders, referred and asked (plans/CROWD.md, rulings 2 and 4). Bea, on B, follows ada (on A)
    where all can see, so B says it holds her when it asks. A keeps that beside the ask, and
    names B to the next stranger who asks about ada: cy's node, C. When A goes dark, C's pull
    finds ada's new post at B - and never takes B for ada's own machinery.
*/
(HOST_B && HOST_C ? describe : describe.skip)(
    'the crowd: holders, referred and asked',
    function () {
        this.timeout(300000);
        const { unplug, plugIn } = require('./unplug.cjs');

        let ada, adaRoot, bea, beaRoot, cy, cyRoot, viaA, bEndpoint;
        const persona = async (prefix, host) => {
            const who = await makeUserFetch({ prefix, host });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: 'POST' });
            return [who, root];
        };
        const follow = (who, root) =>
            j(
                who,
                `api/identity/${root}/private/kv/contact:${adaRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
        const publish = async (title) => {
            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title,
                    body: 'hi',
                    format: 'plaintext',
                })
            ).json();
            const pub = await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
                method: 'POST',
            });
            return JSON.parse(await pub.text()).post_id;
        };

        before(async () => {
            [ada, adaRoot] = await persona('heldada', HOST);
            await publish('First');
            const { toBase58 } = await import('../../js/speakable.js');
            viaA = toBase58((await (await ada('api/node')).json()).endpoint_id);

            [bea, beaRoot] = await persona('heldbea', HOST_B);
            bEndpoint = String((await (await bea('api/node')).json()).endpoint_id).toLowerCase();
            assert.equal((await bea(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
            await follow(bea, beaRoot);
            await beat(HOST_B, 'mint', beaRoot);
            await beat(HOST_B, 'fold', beaRoot);
            await pullAndFold(HOST_B, adaRoot);

            [cy, cyRoot] = await persona('heldcy', HOST_C);
        });

        it("the author's node keeps a follower's word that it holds her", async () => {
            const { rows } = await sql(
                `SELECT holds FROM identity_demand WHERE root_pubkey = '${adaRoot}'
                 AND lower(endpoint_id) = '${bEndpoint}'`,
            );
            assert.equal(rows[0]?.holds, 1, 'B asked, and said it serves her too');
        });

        it('and names that follower to the next stranger who asks', async () => {
            assert.equal((await cy(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
            await follow(cy, cyRoot);
            await beat(HOST_C, 'mint', cyRoot);
            await beat(HOST_C, 'fold', cyRoot);
            await pullAndFold(HOST_C, adaRoot);
            const { rows } = await sql(
                `SELECT endpoint_id FROM crowd_holders WHERE root_pubkey = '${adaRoot}'`,
                HOST_C,
            );
            assert.ok(
                rows.some((r) => String(r.endpoint_id).toLowerCase() === bEndpoint),
                "C was referred to B, by ada's own node",
            );
        });

        it('so when her node goes dark, her new post comes from the crowd', async () => {
            // C off the network while she posts: her own push would otherwise carry the post to
            // C at once, and the claim would pass with no crowd at all (it did, the first time
            // its mechanism was taken out to watch it fail). Off both ways, because C's own wake
            // pass (every two seconds on the rig) would fetch it from A just as surely; and A
            // goes dark BEFORE C comes back, so there is no moment for that pass to slip into.
            const lastVia = async () =>
                (
                    await sql(
                        `SELECT last_via FROM foreign_fetches WHERE root_pubkey = '${adaRoot}'`,
                        HOST_C,
                    )
                ).rows[0]?.last_via;
            const before = await lastVia();
            let post;
            try {
                await unplug(HOST_C);
                post = await publish('While A was away');
                await beat(HOST, 'fold', adaRoot);
                await beat(HOST, 'demand-push', adaRoot);
                await pullAndFold(HOST_B, adaRoot);
                await unplug(HOST);
                await plugIn(HOST_C);
                await pullAndFold(HOST_C, adaRoot);
            } finally {
                await plugIn(HOST);
                await plugIn(HOST_C);
            }
            const { rows } = await sql(
                `SELECT doc_id FROM feed_journal WHERE reader_root = '${cyRoot}'
                 AND author_root = '${adaRoot}'`,
                HOST_C,
            );
            assert.ok(
                rows.some((r) => r.doc_id === post),
                'the post arrived, from B',
            );
            assert.equal(await lastVia(), before, "and B never became ada's own machinery");
        });
    },
);

/*
    The relay (plans/CROWD.md, ruling 5). Ada is on A; bea, on B, follows her where all can see,
    so B holds her. Cy, on C, follows her QUIETLY, on a node made small - C holds nobody, and its
    door answers no stranger about her. C was referred to B by A, and asked B once while A was
    dark. Now ada posts while C's door is shut, so her own push reaches B alone; C opens again,
    B's fold passes the move on, and C has the post - with no pull of C's own, through a door
    that let B in only because A had named it.
*/
(HOST_B && HOST_C ? describe : describe.skip)('the crowd: holders pass moves on', function () {
    this.timeout(300000);
    const { unplug, plugIn, withUnplugged } = require('./unplug.cjs');

    let ada, adaRoot, bea, beaRoot, cy, cyRoot, viaA, aEndpoint;
    const anonC = makeFetch(HOST_C);
    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };
    const dial = (who, root, key, value) =>
        j(who, `api/identity/${root}/private/kv/contact:${adaRoot}/${key}`, { value }, 'PUT');
    const publish = async (title) => {
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title,
                body: 'hi',
                format: 'plaintext',
            })
        ).json();
        const pub = await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
            method: 'POST',
        });
        return JSON.parse(await pub.text()).post_id;
    };
    const cyHas = async (post) => {
        const { rows } = await sql(
            `SELECT doc_id FROM feed_journal WHERE reader_root = '${cyRoot}'
             AND author_root = '${adaRoot}'`,
            HOST_C,
        );
        return rows.some((r) => r.doc_id === post);
    };

    before(async () => {
        [ada, adaRoot] = await persona('relayada', HOST);
        await publish('First');
        const { toBase58 } = await import('../../js/speakable.js');
        aEndpoint = (await (await ada('api/node')).json()).endpoint_id;
        viaA = toBase58(aEndpoint);
        aEndpoint = String(aEndpoint).toLowerCase();

        [bea, beaRoot] = await persona('relaybea', HOST_B);
        assert.equal((await bea(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
        await dial(bea, beaRoot, 'interest', 'high');
        await beat(HOST_B, 'mint', beaRoot);
        await beat(HOST_B, 'fold', beaRoot);
        await pullAndFold(HOST_B, adaRoot);

        [cy, cyRoot] = await persona('relaycy', HOST_C);
        assert.equal((await j(anonC, 'test/quiet-crowd', { n: 1000000 })).status, 200);
        assert.equal((await cy(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
        await dial(cy, cyRoot, 'interest', 'high');
        await dial(cy, cyRoot, 'edges_public', 'no');
        await beat(HOST_C, 'mint', cyRoot);
        await beat(HOST_C, 'fold', cyRoot);
        await pullAndFold(HOST_C, adaRoot);
        // C asks B once, the crowd rung, so B has C among ada's askers. The gate refuses new
        // connections only, and C's wake pass may already be mid-pull from A when A goes dark:
        // the beat's pull then waits on that one ("a pull from that computer is already
        // waiting"), A finishes serving it, and C never needs the crowd (CI, 2026-10-16: two
        // runs red, 2 of 5 reruns each). So C pulls until B has it down as an asker; once the
        // pull already under way is done, the next one finds A dark.
        const cEndpoint = String((await (await cy('api/node')).json()).endpoint_id).toLowerCase();
        const bHasCy = async () =>
            (
                await sql(
                    `SELECT 1 FROM identity_demand WHERE root_pubkey = '${adaRoot}'
                     AND lower(endpoint_id) = '${cEndpoint}'`,
                    HOST_B,
                )
            ).rows.length > 0;
        await withUnplugged([HOST], async () => {
            for (let i = 0; i < 10 && !(await bHasCy()); i++) {
                if (i > 0) await new Promise((r) => setTimeout(r, 250));
                await pullAndFold(HOST_C, adaRoot);
            }
        });
        const askers = await sql(
            `SELECT lower(endpoint_id) AS e FROM identity_demand WHERE root_pubkey = '${adaRoot}'`,
            HOST_B,
        );
        assert.ok(
            await bHasCy(),
            `C asked B for ada while A was dark, so B has C (${cEndpoint}) among her askers: ${JSON.stringify(askers.rows)}`,
        );
    });

    after(async () => {
        await j(anonC, 'test/quiet-crowd', { n: 10 });
    });

    it("a holder's fold carries the author's new post to the node that asked it", async () => {
        // C off the network while ada posts, so her push reaches B alone; then C's door opens
        // and nothing else does - C can dial nobody, so the post can only arrive pushed. (Its
        // wake pass runs every two seconds on the rig, and the first version of this claim
        // passed on it, relay or no relay.) One `unplug` replaces the last, so there is no
        // moment between the two where C is fully plugged in.
        let post;
        let arrived = false;
        try {
            await unplug(HOST_C);
            post = await publish('Relayed');
            await beat(HOST, 'fold', adaRoot);
            await beat(HOST, 'demand-push', adaRoot);
            await pullAndFold(HOST_B, adaRoot);
            await unplug(HOST_C, { direction: 'outbound' });
            assert.ok(!(await cyHas(post)), 'C was dark while ada pushed');
            // B's fold is the relay's trigger; its push is detached, so C is watched for it.
            await beat(HOST_B, 'fold', adaRoot);
            for (let i = 0; i < 40 && !arrived; i++) {
                await new Promise((r) => setTimeout(r, 250));
                await beat(HOST_C, 'fold', adaRoot);
                arrived = await cyHas(post);
            }
        } finally {
            await plugIn(HOST_C);
        }
        assert.ok(arrived, "B passed ada's post on, and C's quiet door let its holder in");
    });

    it('and never pushes back to the author: her own push is not an ask', async () => {
        const { rows } = await sql(
            `SELECT lower(endpoint_id) AS e FROM identity_demand WHERE root_pubkey = '${adaRoot}'`,
            HOST_B,
        );
        assert.ok(rows.length > 0, "B has ada's askers");
        assert.ok(
            !rows.some((r) => r.e === aEndpoint),
            'A pushed to B, and B did not take it for a follower wanting her',
        );
    });
});

/*
    The wake pass's order (plans/CROWD.md, ruling 6). Cy, on C, follows ada (on A), and C was
    referred to bea's node B, which holds her. C's staleness pull goes to B, not to A, until A
    has gone its six hours (give or take a quarter) unasked; then it goes to A. So a holder that
    is behind keeps C behind exactly that long and no longer.

    B is made behind by keeping it off the network while ada posts, and then letting it answer
    without letting it dial (so its own wake pass can't catch up from A, nor relay). The six
    hours are stood in for by writing C's `author_due_ms` back to zero.
*/
(HOST_B && HOST_C ? describe : describe.skip)(
    'the crowd: the wake pass asks a holder, and the author in time',
    function () {
        this.timeout(300000);
        const { unplug, plugIn } = require('./unplug.cjs');

        let ada, adaRoot, bea, beaRoot, cy, cyRoot, viaA, cEndpoint;
        const persona = async (prefix, host) => {
            const who = await makeUserFetch({ prefix, host });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: 'POST' });
            return [who, root];
        };
        const follow = (who, root) =>
            j(
                who,
                `api/identity/${root}/private/kv/contact:${adaRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
        const publish = async (title) => {
            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title,
                    body: 'hi',
                    format: 'plaintext',
                })
            ).json();
            const pub = await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
                method: 'POST',
            });
            return JSON.parse(await pub.text()).post_id;
        };
        const cyHas = async (post) => {
            const { rows } = await sql(
                `SELECT doc_id FROM feed_journal WHERE reader_root = '${cyRoot}'
                 AND author_root = '${adaRoot}'`,
                HOST_C,
            );
            return rows.some((r) => r.doc_id === post);
        };
        const authorDue = async () =>
            Number(
                (
                    await sql(
                        `SELECT author_due_ms FROM foreign_fetches WHERE root_pubkey = '${adaRoot}'`,
                        HOST_C,
                    )
                ).rows[0]?.author_due_ms,
            );
        const lastAskedOfB = async () =>
            Number(
                (
                    await sql(
                        `SELECT last_asked_ms FROM identity_demand WHERE root_pubkey = '${adaRoot}'
                         AND lower(endpoint_id) = '${cEndpoint}'`,
                        HOST_B,
                    )
                ).rows[0]?.last_asked_ms ?? 0,
            );
        // A minute, not ten seconds (CI 2026-10-18): the wake pass rotates eight mirrors a beat
        // through every persona this node follows, stalest first, and by this file in a full run
        // the rig's node follows some fifty - a cycle is ~14s, and the author just fetched in
        // `before` waits at the back of it. Each wait still returns the moment it holds.
        const until = async (ok) => {
            for (let i = 0; i < 240; i++) {
                await new Promise((r) => setTimeout(r, 250));
                if (await ok()) return true;
            }
            return false;
        };
        const hours = 3600 * 1000;

        before(async () => {
            [ada, adaRoot] = await persona('wakeada', HOST);
            await publish('First');
            const { toBase58 } = await import('../../js/speakable.js');
            viaA = toBase58((await (await ada('api/node')).json()).endpoint_id);

            [bea, beaRoot] = await persona('wakebea', HOST_B);
            assert.equal((await bea(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
            await follow(bea, beaRoot);
            await beat(HOST_B, 'mint', beaRoot);
            await beat(HOST_B, 'fold', beaRoot);
            await pullAndFold(HOST_B, adaRoot);

            [cy, cyRoot] = await persona('wakecy', HOST_C);
            cEndpoint = String((await (await cy('api/node')).json()).endpoint_id).toLowerCase();
            assert.equal((await cy(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
            await follow(cy, cyRoot);
            await beat(HOST_C, 'mint', cyRoot);
            await beat(HOST_C, 'fold', cyRoot);
            await pullAndFold(HOST_C, adaRoot);
        });

        it('hearing from the author puts its next turn six hours off, give or take a quarter', async () => {
            const due = await authorDue();
            const now = Date.now();
            assert.ok(due > now + 4.4 * hours, `due ${due - now}ms from now: not before 4.5h`);
            assert.ok(due < now + 7.5 * hours, `due ${due - now}ms from now: not after 7.5h`);
        });

        it('a holder that is behind keeps the follower behind only until the author is owed', async () => {
            let post;
            try {
                await unplug(HOST_C);
                await unplug(HOST_B);
                post = await publish('B never heard');
                await beat(HOST, 'fold', adaRoot);
                await beat(HOST, 'demand-push', adaRoot);
                // B answers, but can't dial: neither its own wake pass nor a relay moves it.
                await unplug(HOST_B, { direction: 'outbound' });
                const asked = await lastAskedOfB();
                await plugIn(HOST_C);

                assert.ok(
                    await until(async () => (await lastAskedOfB()) > asked),
                    "C's wake pass went to the holder",
                );
                // And another, to be sure it keeps going there rather than on to A.
                const again = await lastAskedOfB();
                assert.ok(await until(async () => (await lastAskedOfB()) > again));
                await beat(HOST_C, 'fold', adaRoot);
                assert.ok(!(await cyHas(post)), 'B had nothing new, and A was not asked');

                // Six hours on: the author is owed the next pull.
                await sql(
                    `UPDATE foreign_fetches SET author_due_ms = 0 WHERE root_pubkey = '${adaRoot}'`,
                    HOST_C,
                );
                assert.ok(
                    await until(async () => {
                        await beat(HOST_C, 'fold', adaRoot);
                        return cyHas(post);
                    }),
                    "the author's turn came, and brought what the holder lacked",
                );
                assert.ok(
                    (await authorDue()) > Date.now() + 4.4 * hours,
                    'and the turn was set again',
                );
            } finally {
                await plugIn(HOST_B);
                await plugIn(HOST_C);
            }
        });
    },
);

/*
    Bodies from the crowd (plans/CROWD.md, ruling 7). Ada, on A, posts; bea's node B follows her
    publicly, holds her, and has the post's words. A reader's node takes the post's header from
    A with its blob door shut, so the words are owed - and A referred it to B in the same
    exchange. Then A goes dark, and the reader's healer gets the words from B.

    The reader is a node that has no household tie to B (as in the first block above): the
    household is the healer's last rung, and would answer for the wrong reason.
*/
(HOST_B && HOST_C ? describe : describe.skip)('the crowd: bodies from the holders', function () {
    this.timeout(300000);
    const { unplug, plugIn } = require('./unplug.cjs');

    let ada, adaRoot, bea, beaRoot, cy, cyRoot, viaA, reader;
    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };
    const follow = (who, root) =>
        j(
            who,
            `api/identity/${root}/private/kv/contact:${adaRoot}/interest`,
            { value: 'high' },
            'PUT',
        );
    const owed = async (host) =>
        (
            await sql(
                `SELECT hex(blob_hash) AS h FROM missing_bodies WHERE root_pubkey = '${adaRoot}'`,
                host,
            )
        ).rows.map((r) => String(r.h).toLowerCase());
    const present = async (host, hash) =>
        (await (await makeFetch(host)(`test/blob/${hash}`)).json()).present;

    before(async function () {
        // A reader with no household tie to B.
        const probe = await makeUserFetch({ prefix: 'bodyprobe', host: HOST_B });
        const bEndpoint = String(
            (await (await probe('api/node')).json()).endpoint_id,
        ).toLowerCase();
        for (const host of [HOST_C, HOST_E].filter(Boolean)) {
            const { rows } = await sql('SELECT DISTINCT endpoint_id FROM identity_peers', host);
            if (!rows.some((r) => String(r.endpoint_id).toLowerCase() === bEndpoint)) {
                reader = host;
                break;
            }
        }
        if (!reader) this.skip();

        [ada, adaRoot] = await persona('bodyada', HOST);
        const { toBase58 } = await import('../../js/speakable.js');
        viaA = toBase58((await (await ada('api/node')).json()).endpoint_id);

        [bea, beaRoot] = await persona('bodybea', HOST_B);
        assert.equal((await bea(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
        await follow(bea, beaRoot);
        await beat(HOST_B, 'mint', beaRoot);
        await beat(HOST_B, 'fold', beaRoot);

        [cy, cyRoot] = await persona('bodycy', reader);
        assert.equal((await cy(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
        await follow(cy, cyRoot);
        await beat(reader, 'mint', cyRoot);
        await beat(reader, 'fold', cyRoot);
    });

    it("a reader whose author is dark gets a post's words from a holder", async () => {
        let hashes;
        try {
            // The reader's blob door shut before she posts: her push reaches it at once, and
            // it would dial straight back for the words.
            await unplug(reader, { alpns: ['blob'] });
            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'Words held by the crowd',
                    body: 'these words travel by hash',
                    format: 'plaintext',
                })
            ).json();
            const pub = await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
                method: 'POST',
            });
            assert.equal(pub.status, 200, await pub.text());

            // B has the post, words and all.
            await pullAndFold(HOST_B, adaRoot);
            await beat(HOST_B, 'bodies-sweep');
            assert.deepEqual(await owed(HOST_B), [], 'B holds every body of hers');

            // The reader takes the header, not the words.
            await pullAndFold(reader, adaRoot);
            await beat(reader, 'bodies-sweep');
            hashes = await owed(reader);
            assert.ok(hashes.length > 0, 'the words are owed');
            const { rows } = await sql(
                `SELECT endpoint_id FROM crowd_holders WHERE root_pubkey = '${adaRoot}'`,
                reader,
            );
            assert.ok(rows.length > 0, 'and A named B as a holder');

            // A goes dark; the reader's blob door opens.
            await unplug(HOST);
            await plugIn(reader);
            await beat(reader, 'bodies-sweep');
        } finally {
            await plugIn(HOST);
            await plugIn(reader);
        }
        assert.deepEqual(await owed(reader), [], 'nothing owed any more');
        for (const h of hashes) {
            assert.ok(await present(reader, h), `the bytes ${h.slice(0, 8)} are here, from B`);
        }
    });
});

/*
    The busy referral (plans/CROWD.md, ruling 3). Ada, on A, is the persona A's askers ask about
    most - a dozen planted askers stand in for her popularity - and bea's node B holds her. A
    newcomer's node, which has never heard of ada, opens her page while A is full
    (`test/admission-full` refuses every unproven connection, as a flood would). A's refusal
    carries B in its close reason, and the newcomer gets her from B.
*/
(HOST_B && HOST_C ? describe : describe.skip)('the crowd: a busy refusal refers', function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, newcomer, viaA, bEndpoint;
    const anonA = makeFetch(HOST);
    const full = (on) => j(anonA, 'test/admission-full', { full: on });
    const planted = (i) => (i + 1).toString(16).padStart(2, '0').repeat(32);
    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };

    before(async function () {
        [ada, adaRoot] = await persona('busyada', HOST);
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title: 'Popular',
                body: 'everybody wants this',
                format: 'plaintext',
            })
        ).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/publish`, { method: 'POST' });
        const { toBase58 } = await import('../../js/speakable.js');
        viaA = toBase58((await (await ada('api/node')).json()).endpoint_id);

        [bea, beaRoot] = await persona('busybea', HOST_B);
        bEndpoint = String((await (await bea('api/node')).json()).endpoint_id).toLowerCase();
        assert.equal((await bea(`api/id/${adaRoot}/profile?via=${viaA}`)).status, 200);
        await j(
            bea,
            `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`,
            { value: 'high' },
            'PUT',
        );
        await beat(HOST_B, 'mint', beaRoot);
        await beat(HOST_B, 'fold', beaRoot);
        await pullAndFold(HOST_B, adaRoot);

        // Her popularity, planted: askers that hold nothing, so only B is ever referred.
        const now = Date.now();
        for (let i = 0; i < 12; i++) {
            await sql(
                `INSERT OR REPLACE INTO identity_demand (root_pubkey, endpoint_id, last_asked_ms, holds)
                 VALUES ('${adaRoot}', '${planted(i)}', ${now}, 0)`,
            );
        }

        // Somebody new, on a node that has never heard of her.
        newcomer = await makeUserFetch({ prefix: 'busynew', host: HOST_C });
        await newcomer('api/identity', { method: 'POST' });
    });

    after(async () => {
        await full(false);
        await sql(
            `DELETE FROM identity_demand WHERE root_pubkey = '${adaRoot}' AND holds = 0
             AND endpoint_id IN (${[...Array(12).keys()].map((i) => `'${planted(i)}'`).join(',')})`,
        );
    });

    it('a newcomer refused by a busy author reaches her through a holder the refusal named', async () => {
        let res;
        try {
            assert.equal((await full(true)).status, 200);
            res = await newcomer(`api/id/${adaRoot}/profile?via=${viaA}`);
        } finally {
            await full(false);
        }
        assert.equal(res.status, 200, await res.text());
        const { rows } = await sql(
            `SELECT endpoint_id FROM crowd_holders WHERE root_pubkey = '${adaRoot}'`,
            HOST_C,
        );
        assert.ok(
            rows.some((r) => String(r.endpoint_id).toLowerCase() === bEndpoint),
            "A's refusal named B",
        );
        const fetched = await sql(
            `SELECT last_via FROM foreign_fetches WHERE root_pubkey = '${adaRoot}'`,
            HOST_C,
        );
        assert.equal(fetched.rows[0]?.last_via ?? null, null, 'and B answered, not A');
    });
});
