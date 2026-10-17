/*
    Group rooms (plans/GROUP_ROOMS.md, 2026-10-16): a room posted to a group is a room post on its
    creator's lane for the group, and its door is the roster. Founding the Potato Bunch opens its
    #general. Bea opens a room of her own in the group; ada, on another node, reads it and speaks
    in it. A stranger is refused at every door. A picture said in a group room becomes one of the
    group's media documents - never a public twin, never a post on the group's page - and reaches
    the other members' nodes. The group's owners moderate every room in it and nobody deputizes.
    And cal, removed from the group, keeps the lines he said before, but says nothing after that
    reaches anyone and sees nothing said after (Curtis: "tests for this pls").
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)('group rooms: the roster is the door', function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, dee, deeRoot, group, general, potluck;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };
    const act = async (who, root, path, body = {}) => {
        const res = await j(who, `api/identity/${root}/groups/${group}/${path}`, body);
        const text = await res.text();
        assert.equal(res.status, 200, `${path}: ${text}`);
        return JSON.parse(text);
    };
    const sync = (who, root) => act(who, root, 'sync');
    const groupPosts = async (who, root) => {
        const res = await who(`api/identity/${root}/groups/${group}/posts`);
        assert.equal(res.status, 200);
        return (await res.json()).posts || [];
    };
    const room = (root, author, doc, rest = '') =>
        `api/identity/${root}/rooms/${author}/${doc}${rest}`;
    const say = (who, root, author, doc, words) =>
        j(who, room(root, author, doc, '/messages'), { words });
    const wordsAt = async (who, root, author, doc) => {
        const res = await who(room(root, author, doc, '/messages'));
        if (res.status !== 200) return { status: res.status, words: [] };
        const items = (await res.json()).items || [];
        return { status: 200, words: items.map((m) => m.words || '') };
    };
    // Pull the room and read it until `test` holds - or give up and answer what was last read.
    const readUntil = async (host, who, root, author, doc, test, tries = 30) => {
        let got = { status: 0, words: [] };
        for (let i = 0; i < tries; i++) {
            await who(room(root, author, doc, '/sync'), { method: 'POST' });
            for (const r of [adaRoot, beaRoot, calRoot]) await beat(host, 'fold', r);
            got = await wordsAt(who, root, author, doc);
            if (test(got)) return got;
            await wait(400);
        }
        return got;
    };
    const rooms = async (who, root) =>
        (await (await who(`api/identity/${root}/rooms`)).json()).items || [];
    const upload = async (who, root, title) => {
        const pic = await (
            await who(`api/identity/${root}/docs/binary?title=${title}`, {
                method: 'POST',
                body: makePng(24, 24),
                file: true,
            })
        ).json();
        assert.ok(pic.doc_id, `the upload minted a document: ${JSON.stringify(pic)}`);
        for (let i = 0; i < 60; i++) {
            if ((await who(`api/identity/${root}/docs/${pic.doc_id}/body`)).status === 200)
                return pic.doc_id;
            await wait(300);
        }
        assert.fail('the picture finished ingesting');
    };

    before(async function () {
        [ada, adaRoot] = await persona('grada');
        [bea, beaRoot] = await persona('grbea', HOST_B);
        [cal, calRoot] = await persona('grcal', HOST_C);
        [dee, deeRoot] = await persona('grdee', HOST_B);
        const founded = await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Potato Bunch' });
        const roster = await founded.json();
        group = roster.group;
        general = roster.room;
        for (const [who, root] of [
            [bea, beaRoot],
            [cal, calRoot],
        ]) {
            const token = await act(ada, adaRoot, 'invites', { invitee: root });
            await act(who, root, 'join', {
                invite: token.invite,
                founder: token.founder,
                inviter: token.inviter,
                via: token.via,
            });
        }
        await sync(ada, adaRoot);
        await sync(bea, beaRoot);
        await sync(cal, calRoot);
        await sync(ada, adaRoot);
    });

    it('founding a group opens its #general, and every member finds it in their chats', async () => {
        assert.ok(general, 'the founding named a standing room');
        assert.equal(general.author, adaRoot, "the founder's");
        for (const [who, root] of [
            [ada, adaRoot],
            [bea, beaRoot],
        ]) {
            const listed = (await rooms(who, root)).find((r) => r.doc_id === general.doc_id);
            assert.ok(listed, `#general is in the chats of ${root === adaRoot ? 'ada' : 'bea'}`);
            assert.equal(listed.title, 'general');
            assert.equal(listed.group, group);
            assert.equal(listed.group_name, 'Potato Bunch');
            assert.ok(listed.standing, 'marked as the standing room');
        }
        // Only an owner opens another one, and only when the group has none.
        const again = await j(ada, `api/identity/${adaRoot}/groups/${group}/general`, {});
        assert.equal(again.status, 400, 'the group already has its #general');
    });

    it("a member's room in the group is read and spoken in from another member's node", async () => {
        const draft = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'potluck',
                body: 'who brings what',
                format: 'marquee',
            })
        ).json();
        potluck = (await act(bea, beaRoot, 'publish', { doc: draft.doc_id, room: true })).post;
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        const listed = (await rooms(ada, adaRoot)).find((r) => r.doc_id === potluck);
        assert.ok(listed, "bea's room is in ada's chats");
        assert.equal(listed.group, group);
        assert.ok(!listed.standing);
        const entered = await ada(room(adaRoot, beaRoot, potluck));
        const text = await entered.text();
        assert.equal(entered.status, 200, text);
        assert.equal(JSON.parse(text).group, group);

        assert.equal((await say(bea, beaRoot, beaRoot, potluck, 'i have the salad')).status, 200);
        const atAda = await readUntil(HOST, ada, adaRoot, beaRoot, potluck, (h) =>
            h.words.includes('i have the salad'),
        );
        assert.ok(atAda.words.includes('i have the salad'), JSON.stringify(atAda));
        assert.equal((await say(ada, adaRoot, beaRoot, potluck, 'and i the rolls')).status, 200);
        const atBea = await readUntil(HOST_B, bea, beaRoot, beaRoot, potluck, (h) =>
            h.words.includes('and i the rolls'),
        );
        assert.ok(atBea.words.includes('and i the rolls'), JSON.stringify(atBea));
        // A room is a room on the group's page too, not a post beside it.
        const posts = await groupPosts(ada, adaRoot);
        assert.ok(posts.some((p) => p.doc === potluck));
    });

    it('a stranger is refused at every door', async () => {
        for (const [author, doc] of [
            [beaRoot, potluck],
            [adaRoot, general.doc_id],
        ]) {
            assert.equal((await dee(room(deeRoot, author, doc))).status, 403, 'entering');
            assert.equal((await dee(room(deeRoot, author, doc, '/messages'))).status, 403);
            assert.equal((await say(dee, deeRoot, author, doc, 'let me in')).status, 403);
        }
        assert.ok(!(await rooms(dee, deeRoot)).some((r) => r.group === group));
        const searched = await (await dee(`api/identity/${deeRoot}/rooms/search?q=salad`)).json();
        assert.equal((searched.items || []).length, 0, 'nor does a search find the words');
    });

    it("a picture said in a group room is the group's, and reaches the other members", async () => {
        const pic = await upload(bea, beaRoot, 'salad');
        const said = await say(
            bea,
            beaRoot,
            beaRoot,
            potluck,
            `like this\n\n![salad](/api/identity/${beaRoot}/docs/${pic}/body/salad.avif)`,
        );
        assert.equal(said.status, 200, await said.text());
        const atBea = await wordsAt(bea, beaRoot, beaRoot, potluck);
        const line = atBea.words.find((w) => w.includes('like this'));
        assert.ok(line, JSON.stringify(atBea));
        const m = line.match(new RegExp(`/api/groups/${group}/docs/([0-9a-f]{32})/body/`));
        assert.ok(m, `the words point at the group's media: ${line}`);
        assert.ok(!line.includes('/api/identity/'), 'no private reference survives the say');
        const media = m[1];
        // Not a post on the group's page.
        const posts = await groupPosts(bea, beaRoot);
        assert.ok(!posts.some((p) => p.doc === media), "a room's picture is no post");
        // And ada's node brings it in with the group.
        const atAda = await readUntil(HOST, ada, adaRoot, beaRoot, potluck, (h) =>
            h.words.some((w) => w.includes('like this')),
        );
        assert.ok(atAda.words.some((w) => w.includes(`/docs/${media}/body/`)));
        let bytes;
        for (let i = 0; i < 40; i++) {
            bytes = await ada(`api/groups/${group}/docs/${media}/body/salad.avif`);
            if (bytes.status === 200) break;
            await sync(ada, adaRoot);
            await wait(400);
        }
        assert.equal(bytes.status, 200, "the picture's bytes reached ada's node");
        assert.equal(bytes.headers.get('content-type'), 'image/avif');
        // A stranger on bea's own node is shown nothing of it.
        assert.equal((await dee(`api/groups/${group}/docs/${media}/body`)).status, 404);
    });

    it("the group's owners moderate every room in it, and nobody deputizes", async () => {
        // Ada owns the group and didn't make bea's room: she mutes in it all the same.
        const mute = await ada(room(adaRoot, beaRoot, potluck, `/mutes/${calRoot}`), {
            method: 'POST',
        });
        assert.equal(mute.status, 200, await mute.text());
        const entered = await (await ada(room(adaRoot, beaRoot, potluck))).json();
        assert.ok(entered.moderates, 'ada moderates the room');
        assert.ok(entered.muted.includes(calRoot), 'and cal is muted there');
        const unmute = await ada(room(adaRoot, beaRoot, potluck, `/mutes/${calRoot}`), {
            method: 'DELETE',
        });
        assert.equal(unmute.status, 200, await unmute.text());
        // Bea, the room's creator, can't mute an owner; cal, a member, moderates nothing.
        await sync(ada, adaRoot);
        await sync(bea, beaRoot);
        const up = await bea(room(beaRoot, beaRoot, potluck, `/mutes/${adaRoot}`), {
            method: 'POST',
        });
        assert.equal(up.status, 403, 'an owner is never muted');
        await sync(cal, calRoot);
        const byCal = await cal(room(calRoot, beaRoot, potluck, `/mutes/${beaRoot}`), {
            method: 'POST',
        });
        assert.ok([403, 404].includes(byCal.status), `cal can't: ${byCal.status}`);
        // Nobody deputizes in a group's room, not even its creator.
        const badge = await bea(room(beaRoot, beaRoot, potluck, `/deputies/${calRoot}`), {
            method: 'POST',
        });
        assert.equal(badge.status, 400, await badge.text());
    });

    it("a removed member's lines stay, but they say nothing more that lands and see nothing said after", async () => {
        // Cal speaks in #general while he's in the group.
        assert.equal(
            (await cal(room(calRoot, adaRoot, general.doc_id))).status,
            200,
            'cal enters #general',
        );
        assert.equal(
            (await say(cal, calRoot, adaRoot, general.doc_id, 'hello from cal')).status,
            200,
        );
        const before = await readUntil(HOST, ada, adaRoot, adaRoot, general.doc_id, (h) =>
            h.words.includes('hello from cal'),
        );
        assert.ok(before.words.includes('hello from cal'), JSON.stringify(before));

        // Ada removes him, and the group's nodes learn it.
        await act(ada, adaRoot, 'remove', { target: calRoot });
        await sync(ada, adaRoot);
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        await cal(`api/identity/${calRoot}/groups/${group}/sync`, { method: 'POST' });

        // Ada and bea go on talking.
        assert.equal(
            (await say(ada, adaRoot, adaRoot, general.doc_id, 'cal has gone')).status,
            200,
        );
        assert.equal((await say(bea, beaRoot, adaRoot, general.doc_id, 'so he has')).status, 200);
        const atBea = await readUntil(HOST_B, bea, beaRoot, adaRoot, general.doc_id, (h) =>
            h.words.includes('cal has gone'),
        );
        assert.ok(atBea.words.includes('cal has gone'), JSON.stringify(atBea));
        assert.ok(atBea.words.includes('hello from cal'), 'his line from before stays');

        // Cal tries: his own node may not know yet that he's out, so his say may stand there -
        // but it reaches nobody.
        const late = await say(cal, calRoot, adaRoot, general.doc_id, 'still here');
        assert.ok([200, 403].includes(late.status), `cal's say: ${late.status}`);
        await cal(room(calRoot, adaRoot, general.doc_id, '/sync'), { method: 'POST' });
        await beat(HOST_C, 'fold', calRoot);
        for (const [host, who, root] of [
            [HOST, ada, adaRoot],
            [HOST_B, bea, beaRoot],
        ]) {
            const there = await readUntil(
                host,
                who,
                root,
                adaRoot,
                general.doc_id,
                (h) => h.words.includes('still here'),
                6,
            );
            assert.ok(!there.words.includes('still here'), `nobody hears cal: ${there.words}`);
            assert.ok(there.words.includes('hello from cal'), 'and his old line stands');
        }
        // And what was said after he went never reaches him, however he asks.
        const atCal = await readUntil(
            HOST_C,
            cal,
            calRoot,
            adaRoot,
            general.doc_id,
            (h) => h.words.includes('cal has gone') || h.words.includes('so he has'),
            6,
        );
        assert.ok(
            !atCal.words.includes('cal has gone') && !atCal.words.includes('so he has'),
            `cal sees nothing said after: ${atCal.status} ${atCal.words}`,
        );
        // Nor does a room he never read open to him now.
        const potluckAtCal = await readUntil(
            HOST_C,
            cal,
            calRoot,
            beaRoot,
            potluck,
            (h) => h.words.includes('i have the salad'),
            4,
        );
        assert.ok(!potluckAtCal.words.includes('and i the rolls'), JSON.stringify(potluckAtCal));
    });
    it('a line naming a member rings their bell with the room by name; a stranger named hears nothing', async () => {
        const { speakable } = await import('../../js/speakable.js');
        const bell = async (who, root) =>
            ((await (await who(`api/identity/${root}/notifications`)).json()).items || []).filter(
                (i) => i.kind === 'room-mention' && i.doc_id === potluck,
            );
        const said = await say(
            bea,
            beaRoot,
            beaRoot,
            potluck,
            `[user id=/id/${speakable(adaRoot)}]ada[/user] and [user id=/id/${speakable(deeRoot)}]dee[/user], rolls?`,
        );
        assert.equal(said.status, 200, await said.text());
        let rows = [];
        for (let i = 0; i < 30 && rows.length === 0; i++) {
            await beat(HOST_B, 'outbox');
            rows = await bell(ada, adaRoot);
            if (rows.length === 0) await wait(400);
        }
        assert.equal(rows.length, 1, "the mention rang ada's bell");
        assert.equal(rows[0].author, beaRoot);
        assert.equal(rows[0].detail, beaRoot, "the room's author - its address");
        assert.equal(
            rows[0].doc_title,
            'potluck',
            "worn as the room's name, off the group's record",
        );
        await beat(HOST_B, 'outbox');
        assert.equal((await bell(dee, deeRoot)).length, 0, 'dee, no member, is never told');
    });

    it("a room's creator closes it, the closing reaches the members, and #general stays open", async () => {
        // Only the room's own creator: ada owns the group, but potluck is bea's.
        assert.equal(
            (await j(ada, `api/identity/${adaRoot}/groups/${group}/docs/${potluck}/close`, {}))
                .status,
            404,
        );
        const closed = await j(
            bea,
            `api/identity/${beaRoot}/groups/${group}/docs/${potluck}/close`,
            {},
        );
        assert.equal(closed.status, 200, await closed.text());
        const atBea = await (await bea(room(beaRoot, beaRoot, potluck))).json();
        assert.ok(atBea.closed, 'closed at bea');
        assert.equal((await say(bea, beaRoot, beaRoot, potluck, 'one more thing')).status, 400);
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        const atAda = await (await ada(room(adaRoot, beaRoot, potluck))).json();
        assert.ok(atAda.closed, 'and at ada');
        assert.equal((await say(ada, adaRoot, beaRoot, potluck, 'wait')).status, 400);
        const said = await wordsAt(ada, adaRoot, beaRoot, potluck);
        assert.ok(said.words.includes('i have the salad'), 'the record stands');
        // The group's #general is the group's, and stays open.
        const general_ = await j(
            ada,
            `api/identity/${adaRoot}/groups/${group}/docs/${general.doc_id}/close`,
            {},
        );
        assert.equal(general_.status, 400, await general_.text());
        assert.ok((await (await ada(room(adaRoot, adaRoot, general.doc_id))).json()).standing);
    });

    it("a room's creator deletes it, the takedown reaches the members, and #general stays", async () => {
        const draft = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'bake sale',
                body: 'who bakes what',
                format: 'marquee',
            })
        ).json();
        const sale = (await act(bea, beaRoot, 'publish', { doc: draft.doc_id, room: true })).post;
        assert.equal((await say(bea, beaRoot, beaRoot, sale, 'scones')).status, 200);
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        assert.ok(
            (await rooms(ada, adaRoot)).some((r) => r.doc_id === sale),
            'listed at ada',
        );
        // Only the room's own creator: ada owns the group, but the sale is bea's.
        assert.equal(
            (await j(ada, `api/identity/${adaRoot}/groups/${group}/docs/${sale}/retract`, {}))
                .status,
            403,
        );
        const gone = await j(
            bea,
            `api/identity/${beaRoot}/groups/${group}/docs/${sale}/retract`,
            {},
        );
        assert.equal(gone.status, 200, await gone.text());
        assert.ok(!(await rooms(bea, beaRoot)).some((r) => r.doc_id === sale), 'gone at bea');
        assert.notEqual((await bea(room(beaRoot, beaRoot, sale))).status, 200);
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        assert.ok(!(await rooms(ada, adaRoot)).some((r) => r.doc_id === sale), 'and at ada');
        assert.notEqual((await ada(room(adaRoot, beaRoot, sale))).status, 200);
        assert.ok(!(await groupPosts(ada, adaRoot)).some((p) => p.doc === sale));
        // The group's #general is the group's, and stays.
        const general_ = await j(
            ada,
            `api/identity/${adaRoot}/groups/${group}/docs/${general.doc_id}/retract`,
            {},
        );
        assert.equal(general_.status, 400, await general_.text());
    });
});
