/*
    Housemates (2026-09-25): two people on ONE node, the way a first try of this app actually
    looks - two browsers, two accounts, one `just start`. Every other chat and attention claim
    puts its two people on different nodes, and Curtis's first real session found the same-node
    case broken in two places at once: a chat A opened with B never showed up for B, B could
    then open a second chat with A, and nothing ever rang.

    The relationships are Curtis's: B trusts A and does not follow them; A opens the chat.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

describe('housemates: two people on one node', function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, speakable, chat;

    const rooms = async (who, root) =>
        (await (await who(`api/identity/${root}/rooms`)).json()).items || [];
    const alertsFor = async (root) =>
        (await (await makeFetch(HOST)(`test/attention?root=${root}`)).json()) || [];

    before(async function () {
        ({ speakable } = await import('../../js/speakable.js'));
        ada = await makeUserFetch({ prefix: 'houseada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        bea = await makeUserFetch({ prefix: 'housebea' });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: 'POST' });
        // Bea trusts ada, and does not follow her.
        await j(
            bea,
            `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/trust`,
            { value: 'high' },
            'PUT',
        );
        await beat(HOST, 'mint', beaRoot);
    });

    it("a chat ada opens with bea shows up in bea's chats", async () => {
        // What the client does: ask for the pair's chat, and mint one when there is none.
        assert.equal(
            (await ada(`api/identity/${adaRoot}/ims/${beaRoot}`)).status,
            404,
            'no chat yet',
        );
        const body = `[user id=/id/${speakable(beaRoot)}]bea[/user]`;
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title: 'a chat',
                body,
                format: 'marquee',
            })
        ).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: 'PUT' });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
            room: true,
            im: true,
            trusted_only: true,
            audience: '@mentioned',
        });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        chat = JSON.parse(text).post_id;
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages`, {
            words: 'hi bea',
        });
        assert.equal(said.status, 200, await said.text());

        let row = null;
        for (let i = 0; i < 30 && !row; i++) {
            await beat(HOST, 'outbox');
            await beat(HOST, 'fold', beaRoot);
            row = (await rooms(bea, beaRoot)).find((r) => r.doc_id === chat);
            if (!row) await wait(300);
        }
        assert.ok(row, `bea's chats list ada's chat: ${JSON.stringify(await rooms(bea, beaRoot))}`);
        assert.ok(!row.request, 'not as a request: bea trusts ada');
    });

    it("bea asking for her chat with ada finds ada's - never a second one", async () => {
        const found = await bea(`api/identity/${beaRoot}/ims/${adaRoot}`);
        assert.equal(found.status, 200, `bea finds the pair's chat: ${await found.clone().text()}`);
        const it = await found.json();
        assert.equal(it.author, adaRoot);
        assert.equal(it.doc_id, chat);
    });

    it("ada's line rings for bea", async () => {
        let alert = null;
        for (let i = 0; i < 30 && !alert; i++) {
            alert = (await alertsFor(beaRoot)).find((a) => a.body === 'hi bea');
            if (!alert) await wait(300);
        }
        assert.ok(alert, `bea was alerted: ${JSON.stringify(await alertsFor(beaRoot))}`);
    });
});

/*
    Three on one node (Curtis, 2026-10-01, the first live demo): A trusts both B and C, opens a
    private chat with B - and C, trusted, saw it and said hi in it. A chat for two is sealed to the
    one person it names; trust is not the audience.
*/
describe('housemates: a private chat stays between the two, whoever else is trusted', function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, speakable, chat;
    const rooms = async (who, root) =>
        (await (await who(`api/identity/${root}/rooms`)).json()).items || [];

    before(async function () {
        ({ speakable } = await import('../../js/speakable.js'));
        const person = async (prefix) => {
            const who = await makeUserFetch({ prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: 'POST' });
            return [who, root];
        };
        [ada, adaRoot] = await person('trioada');
        [bea, beaRoot] = await person('triobea');
        [cal, calRoot] = await person('triocal');
        // Ada trusts them both; they're interested in her, as a new account is in its first follows.
        for (const r of [beaRoot, calRoot]) {
            await j(
                ada,
                `api/identity/${adaRoot}/private/kv/contact:${r}/trust`,
                { value: 'high' },
                'PUT',
            );
        }
        for (const [who, root] of [
            [bea, beaRoot],
            [cal, calRoot],
        ]) {
            await j(
                who,
                `api/identity/${root}/private/kv/contact:${adaRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
        }
        await beat(HOST, 'mint', adaRoot);
        const body = `:::user id=/id/${speakable(beaRoot)}:::`;
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, { title: 'bea', body, format: 'marquee' })
        ).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: 'PUT' });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
            room: true,
            im: true,
            trusted_only: true,
            audience: '@mentioned',
        });
        assert.equal(pub.status, 200, await pub.clone().text());
        chat = (await pub.json()).post_id;
        const said = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages`, {
            words: 'just for bea',
        });
        assert.equal(said.status, 200, await said.text());
        for (let i = 0; i < 10; i++) {
            await beat(HOST, 'outbox');
            await beat(HOST, 'fold', beaRoot);
            await beat(HOST, 'fold', calRoot);
            if ((await rooms(bea, beaRoot)).some((r) => r.doc_id === chat)) break;
            await wait(300);
        }
    });

    it('bea has it', async () => {
        assert.ok(
            (await rooms(bea, beaRoot)).some((r) => r.doc_id === chat),
            'the one it names',
        );
        assert.equal((await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${chat}`)).status, 200);
    });

    it('cal, trusted too, never sees it: not listed, not opened, not read, not spoken in', async () => {
        // Every door at once, so a failure names all the leaks rather than the first.
        const leaks = [];
        const listed = await rooms(cal, calRoot);
        if (listed.some((r) => r.doc_id === chat)) leaks.push("listed in cal's chats");
        const open = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${chat}`);
        if (open.status === 200) leaks.push(`opened: ${(await open.text()).slice(0, 200)}`);
        const body = await cal(`id/${adaRoot}/docs/${chat}/body`);
        if (body.status === 200) leaks.push(`its words read: ${(await body.text()).slice(0, 80)}`);
        const said = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${chat}/messages`);
        if (said.status === 200 && (await said.text()).includes('just for bea'))
            leaks.push("ada's line read");
        const hi = await j(cal, `api/identity/${calRoot}/rooms/${adaRoot}/${chat}/messages`, {
            words: 'hi from cal',
        });
        if (hi.status === 200) leaks.push('cal said hi');
        await beat(HOST, 'outbox');
        const heard = await (
            await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages`)
        ).text();
        if (heard.includes('hi from cal')) leaks.push('ada heard cal');
        assert.deepEqual(leaks, []);
    });
});
