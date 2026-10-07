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
const { sql, makeFetch } = require('./fetch.cjs');

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
        // The upload is also the "Upload an image" contract (2026-10-04): H$ 5,000, once.
        assert.deepEqual(paid(b, 'contract'), [500000], 'the picture completes a contract');
        assert.equal(
            b.balance,
            String(3700 + 50 + 1000 + 1000 + 4950 + 500000),
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

    it("a contract: upload an image - your own, never a drawing's flattened copy (2026-10-04)", async () => {
        const lee = await makeUserFetch({ prefix: 'banklee' });
        const root = (await (await lee('api/identity', { method: 'POST' })).json()).root_pubkey;
        const uploaded = async () => {
            const b = await (await lee(`api/identity/${root}/bank`)).json();
            const c = (b.contracts || []).find((x) => x.id === 'upload-an-image');
            return !!(c && c.completed_ms);
        };
        const upload = async () => {
            const pic = await (
                await lee(`api/identity/${root}/docs/binary?title=a picture`, {
                    method: 'POST',
                    body: makePng(20, 20),
                    file: true,
                })
            ).json();
            for (let i = 0; i < 60; i++) {
                if ((await lee(`api/identity/${root}/docs/${pic.doc_id}/body`)).status === 200)
                    break;
                await wait(250);
            }
            return pic.doc_id;
        };
        // A drawing's flattened copy, as the image picker makes one: marked before the bank looks.
        const drawing = await (
            await j(lee, `api/identity/${root}/docs`, {
                title: 'pony',
                body: '{"strokes":[]}',
                format: 'drawing',
            })
        ).json();
        const copy = await upload();
        await j(
            lee,
            `api/identity/${root}/docs/${copy}/annotations/fields/flattened_from`,
            { value: drawing.doc_id },
            'PUT',
        );
        assert.equal(await uploaded(), false, "a drawing's copy is not an upload of your own");
        await upload();
        assert.equal(await uploaded(), true, 'a picture of your own is');
    });

    it('a contract: set your profile picture - pays H$ 2,500 once (2026-10-04)', async () => {
        const mo = await makeUserFetch({ prefix: 'bankmo' });
        const root = (await (await mo('api/identity', { method: 'POST' })).json()).root_pubkey;
        const pictured = async () => {
            const b = await (await mo(`api/identity/${root}/bank`)).json();
            const c = (b.contracts || []).find((x) => x.id === 'set-a-profile-picture');
            const paid = b.lines.filter(
                (l) => l.kind === 'contract' && l.source === 'set-a-profile-picture',
            );
            return { done: !!(c && c.completed_ms), paid: paid.map((l) => Number(l.pennies)) };
        };
        assert.equal((await pictured()).done, false, 'a new persona has no picture');
        const form = new FormData();
        form.append('image', new Blob([makePng(64, 64)], { type: 'image/png' }), 'me.png');
        const set = await mo(`api/identity/${root}/avatar`, {
            method: 'POST',
            body: form,
            file: true,
        });
        assert.equal(set.status, 200, await set.text());
        assert.deepEqual(await pictured(), { done: true, paid: [250000] }, 'an avatar chosen is');
        assert.deepEqual(await pictured(), { done: true, paid: [250000] }, 'and it pays once');
    });

    it('a contract: customize your colorway - any chosen, the default too - pays H$ 2,500 once (2026-10-04)', async () => {
        const nia = await makeUserFetch({ prefix: 'banknia' });
        const root = (await (await nia('api/identity', { method: 'POST' })).json()).root_pubkey;
        const chosen = async () => {
            const b = await (await nia(`api/identity/${root}/bank`)).json();
            const c = (b.contracts || []).find((x) => x.id === 'choose-a-colorway');
            const paid = b.lines.filter(
                (l) => l.kind === 'contract' && l.source === 'choose-a-colorway',
            );
            return { done: !!(c && c.completed_ms), paid: paid.map((l) => Number(l.pennies)) };
        };
        assert.equal((await chosen()).done, false, 'never chosen, not done');
        await j(nia, `api/identity/${root}/profile`, { field: 'colorway', value: 'horse-relax' });
        assert.deepEqual(
            await chosen(),
            { done: true, paid: [250000] },
            'the default, chosen on purpose, counts',
        );
        await j(nia, `api/identity/${root}/profile`, { field: 'colorway', value: 'witchlight' });
        assert.deepEqual(
            await chosen(),
            { done: true, paid: [250000] },
            'and choosing again pays nothing more',
        );
    });

    it('the quick contracts: each action completes its own contract, and nothing else (2026-10-04)', async () => {
        const opal = await makeUserFetch({ prefix: 'bankopal' });
        const root = (await (await opal('api/identity', { method: 'POST' })).json()).root_pubkey;
        const other = await makeUserFetch({ prefix: 'bankother' });
        const otherRoot = (await (await other('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        const { toBase58 } = await import('../../js/speakable.js');
        const quick = [
            'say-hello',
            'tag-a-public-post',
            'tag-a-private-note',
            'react-to-a-post',
            'link-two-notes',
            'organize-a-note',
            'start-a-room',
            'buy-a-horsebond',
        ];
        const doneNow = async () => {
            const b = await (await opal(`api/identity/${root}/bank`)).json();
            return (b.contracts || [])
                .filter((c) => quick.includes(c.id) && c.completed_ms)
                .map((c) => c.id)
                .sort();
        };
        const expect = async (ids, what) =>
            assert.deepEqual(await doneNow(), [...ids].sort(), what);
        const note = async (title, body, bucket = 'default') => {
            const d = await (
                await j(opal, `api/identity/${root}/docs`, { title, body, format: 'marquee' })
            ).json();
            await opal(`api/identity/${root}/docs/${d.doc_id}/buckets/${bucket}`, {
                method: 'PUT',
            });
            return d.doc_id;
        };
        await expect([], 'none yet');

        // Tag a private note.
        const tagged = await note('tagged', 'words');
        await opal(`api/identity/${root}/docs/${tagged}/annotations/tags/soup`, { method: 'PUT' });
        await expect(['tag-a-private-note'], 'a tag on a note');

        // Link one note to another (the index stores links when a list asks for it).
        const target = await note('target', 'here');
        await note(
            'linking',
            `see [the other one](/ringtome/user/${toBase58(root)}/doc/${target})`,
        );
        await opal(`api/identity/${root}/docs`);
        await expect(['tag-a-private-note', 'link-two-notes'], 'a note linking another');

        // Organize a note into a section of a notebook's tree.
        const tax = (title) =>
            j(opal, `api/identity/${root}/taxonomies`, { title }).then((r) => r.json());
        const treeRoot = (await tax('wiki:default')).taxonomy_id;
        const section = (await tax('part one')).taxonomy_id;
        await j(opal, `api/identity/${root}/taxonomies/${treeRoot}/members/${section}`, {}, 'PUT');
        await j(opal, `api/identity/${root}/taxonomies/${section}/members/${target}`, {}, 'PUT');
        await expect(
            ['tag-a-private-note', 'link-two-notes', 'organize-a-note'],
            'a note in a section',
        );

        // Start a room, then say hello in it.
        const draft = await note('a room', 'a place to talk', 'chat');
        const room = (
            await (
                await j(opal, `api/identity/${root}/docs/${draft}/publish`, { room: true })
            ).json()
        ).post_id;
        await expect(
            ['tag-a-private-note', 'link-two-notes', 'organize-a-note', 'start-a-room'],
            'a room started',
        );
        await j(opal, `api/identity/${root}/rooms/${root}/${room}/messages`, { words: 'hello!' });
        await expect(
            [
                'tag-a-private-note',
                'link-two-notes',
                'organize-a-note',
                'start-a-room',
                'say-hello',
            ],
            'a line said',
        );

        // Someone else's post: an emoji on it is a reaction; a word on it is a tag.
        const theirs = await (
            await j(other, `api/identity/${otherRoot}/docs`, {
                title: 'hi',
                body: 'x',
                format: 'marquee',
            })
        ).json();
        const theirPost = (
            await (
                await j(other, `api/identity/${otherRoot}/docs/${theirs.doc_id}/publish`, {})
            ).json()
        ).post_id;
        const label = (value) =>
            opal(`api/identity/${root}/public-annotations/${otherRoot}/${theirPost}`, {
                method: 'PUT',
                body: JSON.stringify({ key: 'tag', value }),
            });
        assert.equal((await label('🐴')).status, 200);
        await expect(
            [
                'tag-a-private-note',
                'link-two-notes',
                'organize-a-note',
                'start-a-room',
                'say-hello',
                'react-to-a-post',
            ],
            'an emoji on their post is a reaction, not a tag',
        );
        assert.equal((await label('lovely')).status, 200);
        await expect(
            [
                'tag-a-private-note',
                'link-two-notes',
                'organize-a-note',
                'start-a-room',
                'say-hello',
                'react-to-a-post',
                'tag-a-public-post',
            ],
            'a word on it is a tag',
        );

        // Buy a hrseBond (the rig credits the price).
        await j(makeFetch(), 'test/credit', { root, pennies: 400000 });
        const bought = await j(opal, `api/identity/${root}/bank/instruments`, {
            kind: 'horsebond',
            pennies: '200000',
        });
        assert.equal(bought.status, 200, await bought.text());
        await expect(quick, 'and a bond bought: every one');
    });

    it('the magic words, said in public, pay H$ 10,000 - for every post that says them (2026-10-05)', async () => {
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
        assert.equal((await magic()).length, 2, 'and again: a cheat said out loud is a cheat paid');
        await publish('quiet', 'nothing magic about this one');
        assert.equal((await magic()).length, 2, 'a post without them still pays nothing');
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
        // A bond bought also completes the "Buy a hrseBond" contract (2026-10-04): it pays once, and
        // the rig takes its H$ 2,500 back so the arithmetic below stays the bonds' own.
        const contracted = (await bank()).lines.filter((l) => l.kind === 'contract');
        assert.deepEqual(
            contracted.map((l) => [l.source, Number(l.pennies)]),
            [['buy-a-horsebond', 250000]],
        );
        await j(rig, 'test/credit', { root, pennies: -250000 });
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

    // HorseBucks are bigints (2026-10-06): a balance past every machine integer is exact, and debt
    // stops growing at the ceiling, the most negative 64-bit number of horsepennies.
    it('a balance past 64 bits is exact, and debt past the ceiling charges nothing', async () => {
        const rich = await persona('bigrich');
        const fortune = 10n ** 30n;
        await j(rig, 'test/credit', { root: rich.root, pennies: fortune.toString() });
        assert.equal((await rich.bank()).balance, String(1000n + fortune), 'to the penny');

        const poor = await persona('bigpoor');
        const sunk = 2n ** 63n + 1000000n; // past the ceiling, already
        await j(rig, 'test/credit', { root: poor.root, pennies: (-sunk).toString() });
        await j(rig, 'test/heartbeat', { root: poor.root, date: dayAfter(1) });
        const b = await poor.bank();
        assert.equal(b.balance, String(2000n - sunk), 'two days of use, and no interest at all');
        assert.ok(!b.lines.some((l) => l.kind === 'debt_interest'), 'not a penny of it');
    });
});

/*
    Unlocks (plans/UNLOCKS.md, 2026-10-05): the Market sells the app's features a piece at a time.
    A purchase is a private register and a spend; the gates themselves are the client's, so what
    the node owes is the sale - priced, in order, never on credit, never twice. The rig's nodes
    hand every persona everything (`everything`), which a sale doesn't change.
*/
describe('HorseBucks: unlocks', function () {
    this.timeout(60000);

    const rig = makeFetch();

    it('an unlock is bought once, in order, out of the balance, and the corner hears of it', async () => {
        const who = await makeUserFetch({ prefix: 'unlockuma' });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        const bank = async () => (await who(`api/identity/${root}/bank`)).json();
        const buy = (id) => j(who, `api/identity/${root}/bank/unlocks`, { id });

        const before = await bank();
        assert.equal(before.everything, true, "the rig's nodes unlock everything");
        assert.deepEqual(
            before.unlocks.slice(0, 3).map((u) => [u.id, u.pennies, u.bought_ms]),
            [
                ['friends', '100000', null],
                ['social', '100000', null],
                ['private-notes', '250000', null],
            ],
        );
        assert.deepEqual(before.contracts.find((c) => c.id === 'tag-a-public-post').requires, [
            'social',
            'tags',
        ]);

        assert.equal((await buy('a-pony')).status, 400, 'no such unlock');
        assert.equal((await buy('chats-for-two')).status, 400, 'Chat and Friends come first');
        assert.equal((await buy('friends')).status, 400, 'no overdraft');

        const start = BigInt(before.balance);
        await j(rig, 'test/credit', { root, pennies: 100000 });
        const bought = await buy('friends');
        assert.equal(bought.status, 200, await bought.text());
        assert.equal((await buy('friends')).status, 400, 'and once only');

        const after = await bank();
        assert.equal(after.balance, String(start), 'H$ 1,000 in, H$ 1,000 spent');
        const line = after.lines.find((l) => l.kind === 'unlock');
        assert.deepEqual([line.source, line.pennies], ['friends', '-100000']);
        assert.ok(after.unlocks.find((u) => u.id === 'friends').bought_ms, 'owned, with when');
        const corner = await (await who(`api/identity/${root}/bank?lines=0`)).json();
        assert.deepEqual(corner.unlocked, ['friends'], 'the corner poll carries the gates');
    });

    // An unlock another persona of the same account owns here sells for 5% (Curtis, 2026-10-07: "a
    // 95% discount ... you already own this somewhere else") - and the ledger charges what was
    // paid, on every computer, because the purchase records it. Another ACCOUNT's purchase counts
    // for nothing.
    it('an unlock another persona of the account owns sells for 5%, and is charged so', async () => {
        const who = await makeUserFetch({ prefix: 'unlockelse' });
        const persona = async () =>
            (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        const [a, b] = [await persona(), await persona()];
        const bank = async (root) => (await who(`api/identity/${root}/bank`)).json();
        const friendsOf = async (root) =>
            (await bank(root)).unlocks.find((u) => u.id === 'friends');

        assert.deepEqual(
            [(await friendsOf(b)).pennies, (await friendsOf(b)).elsewhere],
            ['100000', undefined],
            'nothing owned anywhere: the list price',
        );
        await j(rig, 'test/credit', { root: a, pennies: 100000 });
        assert.equal(
            (await j(who, `api/identity/${a}/bank/unlocks`, { id: 'friends' })).status,
            200,
        );

        const offered = await friendsOf(b);
        assert.deepEqual(
            [offered.pennies, offered.full_pennies, offered.elsewhere],
            ['5000', '100000', true],
            'H$ 50 of H$ 1,000, and why',
        );
        const ownRow = await friendsOf(a);
        assert.equal(ownRow.elsewhere, undefined, 'never on the persona that owns it');

        const start = BigInt((await bank(b)).balance);
        await j(rig, 'test/credit', { root: b, pennies: 5000 });
        const bought = await j(who, `api/identity/${b}/bank/unlocks`, { id: 'friends' });
        assert.equal(bought.status, 200, await bought.text());
        const after = await bank(b);
        assert.equal(after.balance, String(start), 'H$ 50 in, H$ 50 spent');
        const line = after.lines.find((l) => l.kind === 'unlock');
        assert.deepEqual([line.source, line.pennies], ['friends', '-5000']);

        const stranger = await makeUserFetch({ prefix: 'unlockelsex' });
        const theirs = (await (await stranger('api/identity', { method: 'POST' })).json())
            .root_pubkey;
        const theirFriends = (
            await (await stranger(`api/identity/${theirs}/bank`)).json()
        ).unlocks.find((u) => u.id === 'friends');
        assert.deepEqual(
            [theirFriends.pennies, theirFriends.elsewhere],
            ['100000', undefined],
            "another account's purchase counts for nothing",
        );
    });

    // "Unlock everything" (Curtis, 2026-10-07): a node administrator's way out of the tutorial, at
    // H$ 0, offered to nobody else. The rig answers `everything` either way, so the claim is the
    // sale: who is offered it, what it costs, and that it is recorded like any unlock.
    it('a node administrator alone is offered "Unlock everything", for nothing, once', async () => {
        const persona = async (prefix) => {
            const who = await makeUserFetch({ prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            return { who, root, account: who.account.id };
        };
        const bank = async ({ who, root }) => (await who(`api/identity/${root}/bank`)).json();
        const buy = ({ who, root }) =>
            j(who, `api/identity/${root}/bank/unlocks`, { id: 'everything' });

        const plain = await persona('unlockplain');
        assert.notEqual((await bank(plain)).unlocks[0].id, 'everything', 'not offered');
        assert.equal((await buy(plain)).status, 403, 'and not sold');

        const admin = await persona('unlockadmin');
        await sql(
            `INSERT INTO account_tags (account_id, tag) VALUES ('${admin.account}', 'node_admin')`,
        );
        const before = await bank(admin);
        assert.deepEqual(
            [before.unlocks[0].id, before.unlocks[0].pennies, before.unlocks[0].bought_ms],
            ['everything', '0', null],
            'first in the Market, at H$ 0',
        );
        const bought = await buy(admin);
        assert.equal(bought.status, 200, await bought.text());
        assert.equal((await buy(admin)).status, 400, 'and once only');
        const after = await bank(admin);
        assert.equal(after.balance, before.balance, 'it costs nothing');
        assert.ok(!after.lines.some((l) => l.source === 'everything'), 'and pays no line');
        assert.ok(after.unlocks[0].bought_ms, 'owned, with when');
        const corner = await (await admin.who(`api/identity/${admin.root}/bank?lines=0`)).json();
        assert.ok(corner.unlocked.includes('everything'), 'the corner poll carries it');
        assert.equal(corner.everything, true);
    });
});

/*
    The safety contracts and the second batch's (plans/UNLOCKS.md, 2026-10-05): a second persona,
    a second computer, a sealed post, a share, a chat for two. Each completes on the act and on
    nothing near it - a chat for two isn't "a sealed post" nor "a room". Every persona of an
    account that has made a second is done, the new one included.
*/
describe('HorseBucks: the safety contracts, and sealing, sharing and chats for two', function () {
    this.timeout(120000);

    const { HOST_B } = require('./fetch.cjs');
    const { decodeCode } = require('./helpers.cjs');
    const done = async (who, root) =>
        Object.fromEntries(
            ((await (await who(`api/identity/${root}/bank`)).json()).contracts || []).map((c) => [
                c.id,
                !!c.completed_ms,
            ]),
        );
    const NEW = [
        'make-a-second-persona',
        'bring-your-persona',
        'seal-a-post',
        'share-a-post',
        'start-a-chat-for-two',
    ];
    const post = async (who, root, extra = {}) => {
        const d = await (
            await j(who, `api/identity/${root}/docs`, {
                title: 'words',
                body: 'some words for a post',
                format: 'marquee',
            })
        ).json();
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        return JSON.parse(said).post_id;
    };

    it('a sealed post, a second persona, a chat for two and a share each complete theirs', async () => {
        const { speakable } = await import('../../js/speakable.js');
        const ada = await makeUserFetch({ prefix: 'safeada' });
        const root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        const fresh = await done(ada, root);
        assert.deepEqual(
            NEW.filter((id) => fresh[id]),
            [],
            'a new persona on one computer has none of them',
        );

        await post(ada, root);
        assert.equal((await done(ada, root))['seal-a-post'], false, 'an open post is no seal');
        await post(ada, root, { trusted_only: true });
        assert.equal((await done(ada, root))['seal-a-post'], true, 'a trusted-only post is');

        const second = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        assert.equal((await done(ada, root))['make-a-second-persona'], true, 'the first is paid');
        assert.equal(
            (await done(ada, second))['make-a-second-persona'],
            true,
            'and the second starts with it done - no persona waits on the next',
        );

        const im = await (
            await j(ada, `api/identity/${root}/docs`, {
                title: 'a chat',
                body: `[user id=/id/${speakable(second)}]them[/user]`,
                format: 'marquee',
            })
        ).json();
        await ada(`api/identity/${root}/docs/${im.doc_id}/buckets/chat`, { method: 'PUT' });
        const opened = await j(ada, `api/identity/${root}/docs/${im.doc_id}/publish`, {
            room: true,
            im: true,
            trusted_only: true,
            audience: '@mentioned',
        });
        assert.equal(opened.status, 200, await opened.text());
        const after = await done(ada, root);
        assert.equal(after['start-a-chat-for-two'], true, 'a chat for two');
        assert.equal(after['start-a-room'], false, 'is not a room of your own');

        const bo = await makeUserFetch({ prefix: 'safebo' });
        const boRoot = (await (await bo('api/identity', { method: 'POST' })).json()).root_pubkey;
        const theirs = await post(bo, boRoot);
        const shared = await j(ada, `api/identity/${root}/rebroadcasts`, {
            author: boRoot,
            doc_id: theirs,
        });
        assert.equal(shared.status, 200, await shared.text());
        assert.equal((await done(ada, root))['share-a-post'], true, 'a share of somebody else');
    });

    (HOST_B ? it : it.skip)(
        'a persona brought to a second computer completes its contract',
        async () => {
            const ada = await makeUserFetch({ prefix: 'safetwo' });
            const root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
            assert.equal((await done(ada, root))['bring-your-persona'], false);
            const adaOnB = await makeUserFetch({ prefix: 'safetwob', host: HOST_B });
            const request = await (
                await adaOnB('api/identity/adopt/begin', { method: 'POST' })
            ).json();
            assert.ok(decodeCode(request.code).leaf_pubkey, 'a request names its new key');
            const grant = await j(ada, `api/identity/${root}/nodes`, { code: request.code });
            assert.equal(grant.status, 200, await grant.text());
            assert.equal(
                (await done(ada, root))['bring-your-persona'],
                true,
                'granted: the tree holds a key besides the root and the recovery key',
            );
        },
    );
});

/*
    hrseCommodities (plans/COMMODITIES.md, 2026-10-06): seven commodities whose prices walk the same
    on every computer, nudged at most 5% by the node's public feed. A purchase is a lot at today's
    price, never on credit; it sells two UTC days later at the earliest, in part or whole, at the
    day's price; the ledger pays exactly what the lot and the sale recorded. The rig moves a lot's
    purchase back (`/test/age-lot`) - nobody waits two days for a test.
*/
describe('HorseBucks: commodities', function () {
    this.timeout(60000);

    const rig = makeFetch();

    it('quotes seven, buys on the balance, holds two days, and sells in part', async () => {
        const who = await makeUserFetch({ prefix: 'hayhal' });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        const market = async () => (await who(`api/identity/${root}/bank/commodities`)).json();
        const bank = async () => (await who(`api/identity/${root}/bank`)).json();

        const first = await market();
        assert.deepEqual(
            first.commodities.map((c) => c.id),
            ['hay', 'oats', 'carrots', 'apples', 'bridles', 'horseshoes', 'saddles'],
        );
        for (const c of first.commodities) {
            assert.ok(BigInt(c.price) >= 100n, `${c.id} costs at least a HorseBuck`);
            assert.ok(Math.abs(c.nudge_permille) <= 50, `${c.id}'s weather is capped`);
            assert.ok(c.history.length >= 1 && c.history.length <= 30);
        }
        const { rows } = await sql(
            "SELECT COUNT(*) AS n FROM commodity_days WHERE signal = 'posts'",
        );
        assert.ok(Number(rows[0].n) >= 30, 'the weather counted the month in');

        const hay = BigInt(first.commodities[0].price);
        const buy = (units) =>
            j(who, `api/identity/${root}/bank/commodities`, { commodity: 'hay', units });
        assert.equal((await buy('3')).status, 400, 'no overdraft: H$ 10 buys no hay');
        assert.equal((await buy('0')).status, 400, 'a whole number, one or more');
        assert.equal(
            (
                await j(who, `api/identity/${root}/bank/commodities`, {
                    commodity: 'glue',
                    units: '1',
                })
            ).status,
            400,
            'no such commodity',
        );

        await j(rig, 'test/credit', { root, pennies: (hay * 10n).toString() });
        const bought = await buy('3');
        assert.equal(bought.status, 200, await bought.text());
        const lotId = (await market()).lots[0].id;
        const cost = (await bank()).lines.find((l) => l.kind === 'commodity');
        assert.equal(cost.source, lotId);
        assert.equal(BigInt(cost.pennies), -3n * hay, "three at the day's price, out");

        const sell = (units) =>
            j(who, `api/identity/${root}/bank/commodities/${lotId}/sell`, { units });
        assert.equal((await sell('1')).status, 400, 'held two days');
        await j(rig, 'test/age-lot', { root, lot: lotId, days: 2 });
        assert.equal((await sell('4')).status, 400, "a lot doesn't hold more than it bought");
        const sold = await sell('2');
        const said = await sold.text();
        assert.equal(sold.status, 200, said);
        const takings = (await bank()).lines.find((l) => l.kind === 'commodity_sale');
        assert.equal(BigInt(takings.pennies), 2n * BigInt(JSON.parse(said).price));
        const lots = (await market()).lots;
        assert.deepEqual(
            lots.map((l) => [l.id, l.units, l.sellable]),
            [[lotId, '1', true]],
            'one unit left, and sellable',
        );
    });
});
