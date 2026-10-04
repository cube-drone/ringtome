/*
    HorseBucks' ledger (bank.rs, HORSE_BASED_CURRENCIES.md, slice 1; Curtis 2026-09-29). Every
    earning is a line keyed by what earned it, in horsepennies (a hundredth of a HorseBuck), and
    what's paid is what's NEW: a note's second version pays only for the words it added, so a
    paragraph pasted again pays for its seam and nothing else. Asking twice pays nothing twice.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { sql } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

describe('HorseBucks: the ledger', function () {
    this.timeout(120000);

    let ada, root;
    const bank = async () => (await ada(`api/identity/${root}/bank`)).json();
    const paid = (b, kind) => b.lines.filter((l) => l.kind === kind).map((l) => Number(l.pennies));

    before(async () => {
        ada = await makeUserFetch({ prefix: 'bankada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        for (let i = 0; i < 50; i++) {
            const fields = await (await ada(`api/identity/${root}/profile`)).json();
            if (fields.some((f) => f.field === 'heartbeat')) break;
            await wait(100);
        }
    });

    it("pays for what's new, keyed by what earned it, in horsepennies - and never twice", async () => {
        // 150 distinct words: 148 three-word shingles, 25 horsepennies each.
        const words = Array.from({ length: 150 }, (_, i) => `w${i + 1}`);
        const first = words.join(' ');
        const made = await (
            await j(ada, `api/identity/${root}/docs`, {
                title: 'a long note',
                body: first,
                format: 'marquee',
            })
        ).json();
        // The second version pastes the first fifty words again: only the seam is new.
        const got = await (await ada(`api/identity/${root}/docs/${made.doc_id}`)).json();
        const saved = await j(
            ada,
            `api/identity/${root}/docs/${made.doc_id}`,
            {
                title: 'a long note',
                body: `${first} ${words.slice(0, 50).join(' ')}`,
                parents: got.heads.map((h) => h.version),
                format: 'marquee',
            },
            'PUT',
        );
        assert.equal(saved.status, 200, await saved.text());
        // A picture, uploaded.
        const pic = await (
            await ada(`api/identity/${root}/docs/binary?title=a horse`, {
                method: 'POST',
                body: makePng(16, 16),
                file: true,
            })
        ).json();
        for (let i = 0; i < 60; i++) {
            if ((await ada(`api/identity/${root}/docs/${pic.doc_id}/body`)).status === 200) break;
            await wait(250);
        }
        // Published: the words pay again (150 shingles in the published text), plus the size bonus.
        const pub = await j(ada, `api/identity/${root}/docs/${made.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.text());

        const b = await bank();
        assert.deepEqual(
            paid(b, 'words').sort((x, y) => x - y),
            [50, 3700],
            "148 shingles, then only the paste's two-shingle seam",
        );
        assert.deepEqual(paid(b, 'image'), [1000], '10 H$ for the upload');
        assert.deepEqual(paid(b, 'heartbeat'), [1000], '10 H$ for today');
        // 150 shingles x 25 = 3,750, plus a bonus of floor((150 - 100)^2 / 200) = 12 H$.
        assert.deepEqual(
            paid(b, 'publication'),
            [3750 + 1200],
            'the words again, plus the size bonus',
        );
        assert.equal(
            b.balance,
            String(3700 + 50 + 1000 + 1000 + 4950),
            "the balance is the lines' sum, exactly",
        );
        const pubLine = b.lines.find((l) => l.kind === 'publication');
        assert.equal(pubLine.detail.title, 'a long note', 'each line says what it was for');

        // By the month (2026-09-29): every month's total, which sum to the balance, and the newest
        // month's lines by default.
        assert.ok(
            b.months.length >= 1 && b.month === b.months[0].month,
            'the newest month is the one sent',
        );
        assert.equal(
            b.months.reduce((sum, m) => sum + Number(m.pennies), 0),
            Number(b.balance),
            'the months sum to the balance',
        );
        const same = await (await ada(`api/identity/${root}/bank?month=${b.month}`)).json();
        assert.equal(same.lines.length, b.lines.length, 'a month asked for by name');

        const again = await bank();
        assert.equal(again.balance, b.balance, 'asking again pays nothing twice');
    });

    it('a contract: draw a horse (three strokes) and it pays H$ 5,000 once, with one message (2026-10-04)', async () => {
        const cal = await makeUserFetch({ prefix: 'bankcal' });
        const calRoot = (await (await cal('api/identity', { method: 'POST' })).json()).root_pubkey;
        const stroke = (n) => ({
            id: n.toString(16).padStart(16, '0'),
            t: n,
            tool: 'brush',
            color: '#112233',
            size: 4,
            points: [n * 10, n * 10, 5, 0, 5, 0],
        });
        const bankOf = async () => (await cal(`api/identity/${calRoot}/bank`)).json();
        const contract = (b) => (b.contracts || []).find((c) => c.id === 'draw-a-horse');
        const made = await (
            await j(cal, `api/identity/${calRoot}/docs`, {
                title: 'a horse',
                body: JSON.stringify({ strokes: [stroke(1), stroke(2)] }),
                format: 'drawing',
            })
        ).json();
        let b = await bankOf();
        assert.ok(contract(b) && !contract(b).completed_ms, 'two strokes is not yet a horse');
        assert.equal(contract(b).pennies, '500000', 'the reward, in horsepennies');
        const got = await (await cal(`api/identity/${calRoot}/docs/${made.doc_id}`)).json();
        const saved = await j(
            cal,
            `api/identity/${calRoot}/docs/${made.doc_id}`,
            {
                title: 'a horse',
                body: JSON.stringify({ strokes: [stroke(1), stroke(2), stroke(3)] }),
                parents: got.save_parents,
                format: 'drawing',
            },
            'PUT',
        );
        assert.equal(saved.status, 200, await saved.text());
        b = await bankOf();
        assert.ok(contract(b).completed_ms, 'the third stroke completes it');
        const paid = b.lines.filter((l) => l.kind === 'contract');
        assert.deepEqual(
            paid.map((l) => Number(l.pennies)),
            [500000],
            'paid once',
        );
        const kv = await (await cal(`api/identity/${calRoot}/private/kv/contracts`)).json();
        assert.ok(
            (kv.values || []).some((v) => v.key === 'draw-a-horse'),
            'recorded on the private chain',
        );
        const told = async () =>
            (
                (await (await cal(`api/identity/${calRoot}/notifications`)).json()).items || []
            ).filter((n) => n.kind === 'contract');
        const messages = await told();
        assert.equal(messages.length, 1, 'one message in hrseMsg');
        assert.equal(JSON.parse(messages[0].detail).name, 'Draw a horse in hrseDrawing™');
        b = await bankOf();
        assert.equal(
            b.lines.filter((l) => l.kind === 'contract').length,
            1,
            'asking again pays nothing',
        );
        assert.equal((await told()).length, 1, 'and says nothing again');
    });

    it('a contract: post your horse - a drawing published, or a post with a drawing in it - pays H$ 10,000 once (2026-10-04)', async () => {
        const fresh = async (prefix) => {
            const who = await makeUserFetch({ prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            return { who, root };
        };
        const posted = async ({ who, root }) => {
            const b = await (await who(`api/identity/${root}/bank`)).json();
            const c = (b.contracts || []).find((x) => x.id === 'post-a-horse');
            const paid = b.lines.filter(
                (l) => l.kind === 'contract' && l.source === 'post-a-horse',
            );
            return { done: !!(c && c.completed_ms), paid: paid.map((l) => Number(l.pennies)) };
        };
        const upload = async ({ who, root }, title) => {
            const pic = await (
                await who(`api/identity/${root}/docs/binary?title=${title}`, {
                    method: 'POST',
                    body: makePng(24, 24),
                    file: true,
                })
            ).json();
            for (let i = 0; i < 60; i++) {
                if ((await who(`api/identity/${root}/docs/${pic.doc_id}/body`)).status === 200)
                    break;
                await wait(250);
            }
            return pic.doc_id;
        };
        const postWith = async ({ who, root }, picture) => {
            const made = await (
                await j(who, `api/identity/${root}/docs`, {
                    title: 'look',
                    body: `![look](/api/identity/${root}/docs/${picture}/body/look.avif)`,
                    format: 'marquee',
                })
            ).json();
            const pub = await j(who, `api/identity/${root}/docs/${made.doc_id}/publish`, {});
            assert.equal(pub.status, 200, await pub.text());
        };

        // The picker's road: a picture is not a drawing until it is a drawing's flattened copy.
        const eve = await fresh('bankeve');
        await postWith(eve, await upload(eve, 'a photo'));
        assert.equal((await posted(eve)).done, false, 'a post with a photo in it is not a horse');
        const drawing = await (
            await j(eve.who, `api/identity/${eve.root}/docs`, {
                title: 'pony',
                body: '{"strokes":[]}',
                format: 'drawing',
            })
        ).json();
        const copy = await upload(eve, 'pony');
        await j(
            eve.who,
            `api/identity/${eve.root}/docs/${copy}/annotations/fields/flattened_from`,
            { value: drawing.doc_id },
            'PUT',
        );
        await postWith(eve, copy);
        assert.deepEqual(
            await posted(eve),
            { done: true, paid: [1000000] },
            "a drawing's copy in a post is",
        );

        // The drawing's own road: published as itself.
        const dan = await fresh('bankdan');
        const own = await (
            await j(dan.who, `api/identity/${dan.root}/docs`, {
                title: 'horse',
                body: '{"strokes":[]}',
                format: 'drawing',
            })
        ).json();
        const pub = await dan.who(`api/identity/${dan.root}/docs/${own.doc_id}/publish/drawing`, {
            method: 'POST',
            body: makePng(40, 30),
            file: true,
        });
        assert.equal(pub.status, 200, await pub.text());
        assert.deepEqual(
            await posted(dan),
            { done: true, paid: [1000000] },
            'a drawing published is',
        );
        assert.deepEqual(await posted(dan), { done: true, paid: [1000000] }, 'and it pays once');
        const told = (
            (await (await dan.who(`api/identity/${dan.root}/notifications`)).json()).items || []
        ).filter((n) => n.kind === 'contract' && n.doc_id === 'post-a-horse');
        assert.equal(told.length, 1, 'one message');
    });

    it('a contract: follow a stranger - interest of your own accord, never the automatic follows - pays once (2026-10-04)', async () => {
        const persona = async (prefix) => {
            const who = await makeUserFetch({ prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            return { who, root };
        };
        const gus = await persona('bankgus');
        const [marked, listed, stranger] = [
            await persona('bankmarked'),
            await persona('banklisted'),
            await persona('bankstranger'),
        ];
        const setDial = (them, key, value) =>
            j(
                gus.who,
                `api/identity/${gus.root}/private/kv/contact:${them.root}/${key}`,
                { value },
                'PUT',
            );
        const followed = async () => {
            const b = await (await gus.who(`api/identity/${gus.root}/bank`)).json();
            const c = (b.contracts || []).find((x) => x.id === 'follow-a-stranger');
            return {
                done: !!(c && c.completed_ms),
                paid: b.lines.filter(
                    (l) => l.kind === 'contract' && l.source === 'follow-a-stranger',
                ).length,
            };
        };
        // A follow the node made for them (starters.rs, groups.rs mark it `auto`): not theirs.
        await setDial(marked, 'interest', 'low');
        await setDial(marked, 'auto', 'starter');
        assert.equal(
            (await followed()).done,
            false,
            'a marked, automatic follow is not a stranger',
        );
        // On the operator's auto-follow list - how a follow from before the mark looks: not theirs.
        const admin = await makeUserFetch({ prefix: 'bankadm' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
        );
        await j(admin, 'api/admin/auto-follow', { address: listed.root });
        try {
            await setDial(listed, 'interest', 'medium');
            assert.equal(
                (await followed()).done,
                false,
                'someone on the auto-follow list is not a stranger',
            );
        } finally {
            // Cleared before the list lets them go: off the list, an unmarked follow from before the
            // mark would read as the person's own.
            await setDial(listed, 'interest', '');
            await admin(`api/admin/auto-follow/${listed.root}`, { method: 'DELETE' });
        }
        // "none" is no interest.
        await setDial(stranger, 'interest', 'none');
        assert.equal((await followed()).done, false, 'interest "none" is not following');
        // A stranger, followed of their own accord.
        await setDial(stranger, 'interest', 'low');
        assert.deepEqual(await followed(), { done: true, paid: 1 }, 'a stranger followed is');
        assert.deepEqual(await followed(), { done: true, paid: 1 }, 'and it pays once');
    });

    it('a contract: get a follower - someone else, never your own other personas - pays once (2026-10-04)', async () => {
        const hal = await makeUserFetch({ prefix: 'bankhal' });
        const halRoot = (await (await hal('api/identity', { method: 'POST' })).json()).root_pubkey;
        const contract = async () => {
            const b = await (await hal(`api/identity/${halRoot}/bank`)).json();
            const c = (b.contracts || []).find((x) => x.id === 'get-a-follower');
            return {
                done: !!(c && c.completed_ms),
                paid: b.lines.filter((l) => l.kind === 'contract' && l.source === 'get-a-follower')
                    .length,
            };
        };
        const follow = (who, whoRoot) =>
            j(
                who,
                `api/identity/${whoRoot}/private/kv/contact:${halRoot}/interest`,
                { value: 'low' },
                'PUT',
            );
        // Hal's own second persona follows hal: not someone else.
        const alt = (await (await hal('api/identity', { method: 'POST' })).json()).root_pubkey;
        await follow(hal, alt);
        for (let i = 0; i < 12; i++) {
            await wait(250);
            assert.equal(
                (await contract()).done,
                false,
                'your own other persona is not a follower',
            );
        }
        // Somebody else does.
        const ivy = await makeUserFetch({ prefix: 'bankivy' });
        const ivyRoot = (await (await ivy('api/identity', { method: 'POST' })).json()).root_pubkey;
        await follow(ivy, ivyRoot);
        let got = await contract();
        for (let i = 0; i < 80 && !got.done; i++) {
            await wait(250);
            got = await contract();
        }
        assert.deepEqual(got, { done: true, paid: 1 }, 'someone else following is');
        assert.deepEqual(await contract(), { done: true, paid: 1 }, 'and it pays once');
    });

    it('a contract: create a private note in hrseWriter - filed in a Writer notebook - pays H$ 2,500 once (2026-10-04)', async () => {
        const kit = await makeUserFetch({ prefix: 'bankkit' });
        const root = (await (await kit('api/identity', { method: 'POST' })).json()).root_pubkey;
        const wrote = async () => {
            const b = await (await kit(`api/identity/${root}/bank`)).json();
            const c = (b.contracts || []).find((x) => x.id === 'write-a-note');
            const paid = b.lines.filter(
                (l) => l.kind === 'contract' && l.source === 'write-a-note',
            );
            return { done: !!(c && c.completed_ms), paid: paid.map((l) => Number(l.pennies)) };
        };
        const note = async (bucket) => {
            const made = await (
                await j(kit, `api/identity/${root}/docs`, {
                    title: 'untitled',
                    body: '',
                    format: 'marquee',
                })
            ).json();
            if (bucket)
                await kit(`api/identity/${root}/docs/${made.doc_id}/buckets/${bucket}`, {
                    method: 'PUT',
                });
        };
        await note(null);
        assert.equal((await wrote()).done, false, 'an unfiled note is in no Writer notebook');
        await note('feed');
        assert.equal((await wrote()).done, false, "a Feed draft is Feed's, not Writer's");
        await note('default');
        assert.deepEqual(
            await wrote(),
            { done: true, paid: [250000] },
            "a note in Writer's notebook is",
        );
        assert.deepEqual(await wrote(), { done: true, paid: [250000] }, 'and it pays once');
    });

    it('the magic words, said in public, pay H$ 10,000 - once (2026-10-04)', async () => {
        const bea = await makeUserFetch({ prefix: 'bankbea' });
        const beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        const publish = async (title, body) => {
            const made = await (
                await j(bea, `api/identity/${beaRoot}/docs`, { title, body, format: 'marquee' })
            ).json();
            const pub = await j(bea, `api/identity/${beaRoot}/docs/${made.doc_id}/publish`, {});
            assert.equal(pub.status, 200, await pub.text());
        };
        const magic = async () =>
            (await (await bea(`api/identity/${beaRoot}/bank`)).json()).lines.filter(
                (l) => l.kind === 'magic_words',
            );
        await publish('plain', 'nothing to see here');
        assert.deepEqual(await magic(), [], 'a post without them pays nothing of the kind');
        await publish('loud', 'Well then: Show Me The Money!');
        const once = await magic();
        assert.deepEqual(
            once.map((l) => Number(l.pennies)),
            [1000000],
            'H$ 10,000 in horsepennies',
        );
        assert.equal(once[0].detail.said, 'show me the money', 'and the line says which words');
        await publish('again', 'rosebud');
        assert.equal((await magic()).length, 1, 'once per persona - never a press for money');
    });
});

/*
    hrseBonds and debt (HORSE_BASED_CURRENCIES.md; Curtis 2026-09-29, 2026-09-30). A bond costs what
    the balance can pay and no more - "overdraft is for special cases, not the average case". It pays
    1% of its price on each heartbeat day after the day it was bought, for a hundred of them, then
    returns its price. In debt, a bond still paying can be sold for its price: the way out. A
    heartbeat day that ends below zero charges 2% of the balance, rounded toward zero, compounding.
    Heartbeat days and money are written by the rig (`/test/heartbeat`, `/test/credit`): nobody
    waits a hundred days, or earns H$ 4,000, for a test.
*/
describe('HorseBucks: bonds and debt', function () {
    this.timeout(120000);

    const { makeFetch } = require('./fetch.cjs');
    const rig = makeFetch();
    const dayAfter = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const persona = async (prefix) => {
        const who = await makeUserFetch({ prefix });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        for (let i = 0; i < 50; i++) {
            const fields = await (await who(`api/identity/${root}/profile`)).json();
            if (fields.some((f) => f.field === 'heartbeat')) break;
            await wait(100);
        }
        return { who, root, bank: async () => (await who(`api/identity/${root}/bank`)).json() };
    };

    it('a bond costs no more than the balance, pays its interest, sells in debt, and matures', async () => {
        const { who: bea, root, bank } = await persona('bondbea');
        const buy = (pennies) =>
            j(bea, `api/identity/${root}/bank/instruments`, { kind: 'horsebond', pennies });
        const sell = (id) =>
            bea(`api/identity/${root}/bank/instruments/${id}/sell`, { method: 'POST' });
        assert.equal((await bank()).balance, '1000', "today's heartbeat, and nothing else");
        assert.equal((await buy('200000')).status, 400, 'no overdraft: H$ 10 buys no bond');

        await j(rig, 'test/credit', { root, pennies: 399000 });
        assert.equal((await buy('199999')).status, 400, 'a hrseBond costs at least H$ 2,000');
        const huge = await buy('100000001');
        assert.equal(huge.status, 400);
        assert.match(
            await huge.text(),
            /at most/,
            'and at most H$ 1,000,000, whatever the balance',
        );
        for (let n = 0; n < 2; n++) {
            const bought = await buy('200000');
            assert.equal(bought.status, 200, await bought.text());
        }
        assert.equal((await bank()).balance, '0', 'two bonds spend H$ 4,000 exactly');
        assert.equal((await buy('200000')).status, 400, 'and a third is more than the balance');
        const [sold, kept] = (await bank()).instruments;
        assert.equal((await sell(sold.id)).status, 400, 'not in debt: nothing to get out of');

        await j(rig, 'test/credit', { root, pennies: -100000 });
        // Today ends at -H$ 1,000 and pays 2% of it.
        assert.equal((await bank()).balance, '-102000', 'debt charges its interest today');
        const out = await sell(sold.id);
        assert.equal(out.status, 200, await out.text());
        const after = await bank();
        assert.equal(after.balance, '98000', 'the sale returns the price');
        assert.equal(after.instruments.find((b) => b.id === sold.id).sold, true);
        assert.equal((await sell(sold.id)).status, 400, 'and sells once');

        for (let n = 1; n <= 3; n++) {
            await j(rig, 'test/heartbeat', { root, date: dayAfter(n) });
        }
        const three = await bank();
        const keptNow = three.instruments.find((b) => b.id === kept.id);
        assert.equal(keptNow.days, 3, 'three heartbeat days after the purchase');
        assert.equal(keptNow.paid, '6000', '1% of H$ 2,000 each day');
        assert.equal(
            three.instruments.find((b) => b.id === sold.id).paid,
            '0',
            'a sold bond pays nothing after its sale',
        );
        assert.equal(
            three.balance,
            String(98000 + 3 * 1000 + 6000),
            "heartbeats and one bond's interest",
        );

        for (let n = 4; n <= 101; n++) {
            await j(rig, 'test/heartbeat', { root, date: dayAfter(n) });
        }
        const done = (await bank()).instruments;
        const matured = done.find((b) => b.id === kept.id);
        assert.equal(matured.days, 100, 'a hundred days, and no more');
        assert.equal(matured.paid, '200000', 'H$ 20 a day for a hundred days');
        assert.equal(matured.matured, true, 'then its price comes back');
        assert.equal(
            done.find((b) => b.id === sold.id).matured,
            false,
            'a sold bond never matures',
        );
    });

    it('debt compounds, day by day', async () => {
        const { root, bank } = await persona('debtcal');
        await j(rig, 'test/credit', { root, pennies: -100000 });
        for (let n = 1; n <= 3; n++) {
            await j(rig, 'test/heartbeat', { root, date: dayAfter(n) });
        }
        // Today ends at -99,000 and pays -1,980; each later day adds 1,000 for the heartbeat, then
        // charges 2% of what's left, toward zero: -1,999, -2,019, -2,039.
        assert.equal((await bank()).balance, '-104037', 'the debt compounds');
    });
});
