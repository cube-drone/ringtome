/*
    Public groups (plans/PUBLIC_GROUPS.md). A public group gives each member device two lanes: a
    public one for its roster, which anyone may hold, and a members-only one for its posts.

    Slice 1, the lanes: ada founds Cheese Group as public and bea, on another node, joins. Their
    roster entries are on public lanes and bea's members-only post is on her members-only lane,
    reaching ada as any group post does. Dee follows ada from a third node: his node learns ada's
    public lane with the follow - the roster's start - and never a members-only one.

    Slice 2, posting as the group: a member's public post as the group is their own public post,
    which their public lane claims. Its card says "(Cheese Group)". An owner's hide ends that, and
    so does taking the post down; removing a member ends every claim of theirs. Nobody outside
    the group, and no sealed post, posts as it. A drawing posts as it too, by the drawing's door.

    Slice 3, the carry: dee follows ada. Her own post as the group is a post of hers, and comes
    with the follow, marked. Bea's comes through ada only once dee wants ada's rebroadcasts - with
    ada as its via - and goes when ada removes bea.

    Slice 4, following the group itself: eve, on a fourth node, follows no member - only the
    group. Its public posts reach her direct, marked as the group's, and leave when she stops.

    Slice 5, what anyone sees: a public group's page answers a stranger - its face, its members,
    its public posts - and a persona's public groups are listed on theirs. A private group is on
    neither.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C, HOST_E, makeFetch, sql } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const GROUP_SERVICE = 14;
const GROUP_PUBLIC_SERVICE = 15;
const DOC_HEADER = 7;

(HOST_B && HOST_C && HOST_E ? describe : describe.skip)(
    'public groups: two lanes each',
    function () {
        this.timeout(300000);

        let ada, adaRoot, bea, beaRoot, dee, deeRoot, group, post, adasPost;

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
        const lanes = async (host) =>
            (
                await sql(
                    `SELECT service, entry_type, persona FROM group_lanes WHERE group_id = x'${group}'`,
                    host,
                )
            ).rows;

        before(async () => {
            [ada, adaRoot] = await persona('pgada');
            [bea, beaRoot] = await persona('pgbea', HOST_B);
            [dee, deeRoot] = await persona('pgdee', HOST_C);
        });

        it('a public group keeps its roster on public lanes and its posts on members-only ones', async () => {
            const founded = await j(ada, `api/identity/${adaRoot}/groups`, {
                name: 'Cheese Group',
                public: true,
            });
            const roster = await founded.json();
            assert.equal(founded.status, 200, JSON.stringify(roster));
            assert.equal(roster.public, true, 'founded public');
            group = roster.group;
            const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
            await act(bea, beaRoot, 'join', {
                invite: token.invite,
                founder: token.founder,
                inviter: token.inviter,
                via: token.via,
            });
            const d = await (
                await j(bea, `api/identity/${beaRoot}/docs`, {
                    title: 'members only',
                    body: 'just for the cheese people',
                    format: 'marquee',
                })
            ).json();
            post = (await act(bea, beaRoot, 'publish', { doc: d.doc_id })).post;
            await act(bea, beaRoot, 'sync');
            await act(ada, adaRoot, 'sync');
            for (const r of [adaRoot, beaRoot]) await beat(HOST, 'fold', r);
            const page = await (await ada(`api/identity/${adaRoot}/groups/${group}/posts`)).json();
            assert.ok(
                page.posts.some((p) => p.doc === post),
                "bea's post reached ada",
            );
            const roster2 = await (await ada(`api/identity/${adaRoot}/groups/${group}`)).json();
            assert.ok(
                roster2.members.some((m) => m.root === beaRoot),
                'and bea is in',
            );

            const held = await lanes(HOST);
            const pub = held.filter((r) => r.service === GROUP_PUBLIC_SERVICE);
            assert.ok(
                pub.some((r) => r.persona === adaRoot) && pub.some((r) => r.persona === beaRoot),
                'both public lanes held',
            );
            assert.ok(
                held
                    .filter((r) => r.entry_type === DOC_HEADER)
                    .every((r) => r.service === GROUP_SERVICE),
                'every post on a members-only lane',
            );
            assert.ok(
                held.some((r) => r.service === GROUP_SERVICE && r.persona === beaRoot),
                "bea's members-only lane is held by a member's node",
            );
        });

        it("a follower's node learns a member's public lane with the follow, and never a members-only one", async () => {
            const viaAda = await (async () => {
                const { toBase58 } = await import('../../js/speakable.js');
                return toBase58((await (await ada('api/node')).json()).endpoint_id);
            })();
            assert.equal((await dee(`api/id/${adaRoot}/profile?via=${viaAda}`)).status, 200);
            await j(
                dee,
                `api/identity/${deeRoot}/private/kv/contact:${adaRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
            let held = [];
            for (let i = 0; i < 10 && !held.some((r) => r.service === GROUP_PUBLIC_SERVICE); i++) {
                await pullAndFold(HOST_C, adaRoot);
                held = await lanes(HOST_C);
            }
            assert.ok(
                held.some((r) => r.service === GROUP_PUBLIC_SERVICE && r.persona === adaRoot),
                `ada's public lane came with the follow: ${JSON.stringify(held)}`,
            );
            assert.ok(!held.some((r) => r.service === GROUP_SERVICE), 'and nothing members-only');
        });

        const draft = async (who, root, body) =>
            (
                await (
                    await j(who, `api/identity/${root}/docs`, {
                        title: '',
                        body,
                        format: 'marquee',
                    })
                ).json()
            ).doc_id;
        const publishAs = (who, root, doc, extra = {}) =>
            j(who, `api/identity/${root}/docs/${doc}/publish`, { as_group: group, ...extra });
        const claims = async (host) =>
            (
                await sql(
                    `SELECT author, doc FROM group_public_posts WHERE group_id = x'${group}'`,
                    host,
                )
            ).rows;
        const cardOf = async (who, root, doc) => {
            await beat(HOST, 'fold', root);
            const items = (await (await who(`api/identity/${root}/feed`)).json()).items || [];
            return items.find((i) => i.doc_id === doc);
        };

        it("a member's public post as the group is their own, and its card says the group's", async () => {
            const res = await publishAs(
                ada,
                adaRoot,
                await draft(ada, adaRoot, 'cheese for everyone'),
            );
            const text = await res.text();
            assert.equal(res.status, 200, text);
            const said = JSON.parse(text).post_id;
            assert.ok(
                (await claims(HOST)).some((c) => c.author === adaRoot && c.doc === said),
                'claimed',
            );
            const card = await cardOf(ada, adaRoot, said);
            assert.ok(card, 'in her own feed, a public post');
            assert.ok(!card.group, 'not a members-only one');
            assert.deepEqual(card.as_group, { id: group, name: 'Cheese Group' });

            // An owner hides it: the post stays hers, and stops being the group's - and comes back.
            const hide = (hidden) => act(ada, adaRoot, `docs/${said}/hide`, { hidden });
            await hide(true);
            assert.ok(!(await claims(HOST)).some((c) => c.doc === said), 'hidden');
            assert.ok(!(await cardOf(ada, adaRoot, said)).as_group, 'and the card says nothing');
            await hide(false);
            assert.ok(
                (await claims(HOST)).some((c) => c.doc === said),
                'shown again',
            );

            // Taken down, it's the group's no longer.
            const down = await ada(`api/identity/${adaRoot}/posts/${said}`, { method: 'DELETE' });
            assert.equal(down.status, 200, await down.text());
            assert.ok(!(await claims(HOST)).some((c) => c.doc === said), 'taken down');
        });

        it('nobody outside the group, and no sealed post, posts as the group', async () => {
            const stranger = await publishAs(dee, deeRoot, await draft(dee, deeRoot, 'let me in'));
            assert.notEqual(stranger.status, 200, 'dee is no member');
            const sealed = await publishAs(
                ada,
                adaRoot,
                await draft(ada, adaRoot, 'secret cheese'),
                {
                    trusted_only: true,
                },
            );
            assert.equal(sealed.status, 400, 'a sealed post has no public to speak to');
        });

        it("a drawing posts in public as the group, by the drawing's own door", async () => {
            const { writeBody } = await import('../../js/pure/drawing.js');
            const drawn = async (who, root) =>
                (
                    await (
                        await j(who, `api/identity/${root}/docs`, {
                            title: 'a cheese, drawn',
                            body: writeBody({
                                strokes: [
                                    {
                                        id: 'a000000000000001',
                                        t: 1,
                                        tool: 'brush',
                                        color: '#e8c33a',
                                        size: 8,
                                        points: [10, 10, 5, 5, 5, 0],
                                    },
                                ],
                                undone: [],
                            }),
                            format: 'drawing',
                        })
                    ).json()
                ).doc_id;
            const door = (who, root, doc, query = '') =>
                who(
                    `api/identity/${root}/docs/${doc}/publish/drawing?tz_offset_min=0&as_group=${group}${query}`,
                    { method: 'POST', body: makePng(80, 60), file: true },
                );
            const res = await door(ada, adaRoot, await drawn(ada, adaRoot));
            const text = await res.text();
            assert.equal(res.status, 200, text);
            const said = JSON.parse(text).post_id;
            assert.ok(
                (await claims(HOST)).some((c) => c.author === adaRoot && c.doc === said),
                'claimed',
            );
            const card = await cardOf(ada, adaRoot, said);
            assert.ok(card, 'in her own feed, a public post');
            assert.deepEqual(card.as_group, { id: group, name: 'Cheese Group' });

            // The words' door's refusals, at the drawing's: no stranger, no seal.
            const stranger = await door(dee, deeRoot, await drawn(dee, deeRoot));
            assert.notEqual(stranger.status, 200, 'dee is no member');
            const sealed = await door(
                ada,
                adaRoot,
                await drawn(ada, adaRoot),
                '&trusted_only=true',
            );
            assert.equal(sealed.status, 400, 'a sealed drawing has no public to speak to');

            const down = await ada(`api/identity/${adaRoot}/posts/${said}`, { method: 'DELETE' });
            assert.equal(down.status, 200, await down.text());
            assert.ok(!(await claims(HOST)).some((c) => c.doc === said), 'taken down');
        });

        it('removing a member ends every claim they made', async () => {
            const said = JSON.parse(
                await (
                    await publishAs(bea, beaRoot, await draft(bea, beaRoot, 'bea for cheese'))
                ).text(),
            ).post_id;
            assert.ok(said, 'bea posted as the group');
            await act(bea, beaRoot, 'sync');
            await act(ada, adaRoot, 'sync');
            assert.ok(
                (await claims(HOST)).some((c) => c.author === beaRoot && c.doc === said),
                'ada holds it',
            );
            await act(ada, adaRoot, 'remove', { target: beaRoot });
            assert.ok(
                !(await claims(HOST)).some((c) => c.author === beaRoot),
                'gone with her membership',
            );
        });

        it("following a member brings the group's public posts, through them, under the rebroadcast dial", async () => {
            // A fresh public group: Cheese Group lost bea above.
            const founded = await (
                await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Brie Bunch', public: true })
            ).json();
            group = founded.group;
            const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
            await act(bea, beaRoot, 'join', {
                invite: token.invite,
                founder: token.founder,
                inviter: token.inviter,
                via: token.via,
            });
            const posted = async (who, root, body) => {
                const r = await publishAs(who, root, await draft(who, root, body));
                const text = await r.text();
                assert.equal(r.status, 200, text);
                return JSON.parse(text).post_id;
            };
            const hers = await posted(ada, adaRoot, 'brie, said by ada');
            const beas = await posted(bea, beaRoot, 'brie, said by bea');
            await act(bea, beaRoot, 'sync');
            await act(ada, adaRoot, 'sync');

            const deeFeed = async () => {
                await pullAndFold(HOST_C, adaRoot);
                await beat(HOST_C, 'group-sync');
                await beat(HOST_C, 'fragment-sweep', beaRoot);
                await beat(HOST_C, 'fold', deeRoot);
                return (await (await dee(`api/identity/${deeRoot}/feed`)).json()).items || [];
            };
            let items = [];
            for (let i = 0; i < 8 && !items.some((x) => x.doc_id === hers && x.as_group); i++)
                items = await deeFeed();
            const own = items.find((x) => x.doc_id === hers);
            assert.ok(own, "ada's post as the group is a post of hers, with the follow");
            assert.ok(!own.via, 'a direct one');
            assert.deepEqual(own.as_group, { id: group, name: 'Brie Bunch' });
            assert.ok(!items.some((x) => x.doc_id === beas), "bea's waits on ada's rebroadcasts");

            await j(
                dee,
                `api/identity/${deeRoot}/private/kv/contact:${adaRoot}/interest_rebroadcasts`,
                { value: 'high' },
                'PUT',
            );
            for (let i = 0; i < 10 && !items.some((x) => x.doc_id === beas); i++)
                items = await deeFeed();
            const carried = items.find((x) => x.doc_id === beas);
            assert.ok(carried, "bea's post as the group comes through ada");
            assert.equal(carried.via, adaRoot, 'ada its via');
            assert.equal(carried.author, beaRoot);
            assert.deepEqual(carried.as_group, { id: group, name: 'Brie Bunch' });

            await act(ada, adaRoot, 'remove', { target: beaRoot });
            for (let i = 0; i < 10 && items.some((x) => x.doc_id === beas); i++)
                items = await deeFeed();
            assert.ok(!items.some((x) => x.doc_id === beas), "bea's post goes with her membership");
            assert.ok(
                items.some((x) => x.doc_id === hers),
                "ada's stays",
            );
            adasPost = hers;
        });

        it('following the group itself brings its public posts, direct, until you stop', async () => {
            const [eve, eveRoot] = await persona('pgeve', HOST_E);
            const adaNode = (await (await ada(`api/identity/${adaRoot}/machines`)).json()).this
                .endpoint;
            const follow = await j(eve, `api/identity/${eveRoot}/groups/${group}/follow`, {
                via: [adaNode],
                members: [adaRoot],
            });
            assert.equal(follow.status, 200, await follow.text());
            const feed = async () => {
                await beat(HOST_E, 'group-sync');
                await beat(HOST_E, 'fragment-sweep', adaRoot);
                await beat(HOST_E, 'fold', eveRoot);
                return (await (await eve(`api/identity/${eveRoot}/feed`)).json()).items || [];
            };
            let items = [];
            for (let i = 0; i < 10 && !items.some((x) => x.doc_id === adasPost); i++)
                items = await feed();
            const got = items.find((x) => x.doc_id === adasPost);
            assert.ok(got, 'the group brought it');
            assert.ok(!got.via, 'direct, with no member between');
            assert.deepEqual(got.as_group, { id: group, name: 'Brie Bunch' });

            const off = await eve(`api/identity/${eveRoot}/groups/${group}/follow`, {
                method: 'DELETE',
            });
            assert.equal(off.status, 200, await off.text());
            items = (await (await eve(`api/identity/${eveRoot}/feed`)).json()).items || [];
            assert.ok(!items.some((x) => x.doc_id === adasPost), 'and goes when she stops');
        });

        it("a public group's page answers anyone, and a persona's public groups are on theirs", async () => {
            const stranger = makeFetch(HOST);
            const res = await stranger(`api/groups/${group}/public`);
            assert.equal(res.status, 200, await res.clone().text());
            const page = await res.json();
            assert.equal(page.name, 'Brie Bunch');
            assert.ok(
                page.members.some((m) => m.root === adaRoot && m.owner),
                'ada, an owner',
            );
            assert.ok(!page.members.some((m) => m.root === beaRoot), 'bea is gone');
            assert.ok(
                page.posts.some((p) => p.author === adaRoot && p.doc_id === adasPost),
                'its public post',
            );
            assert.ok(page.endpoint, 'and where it was answered');

            const secret = await (
                await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Secret Cheddar' })
            ).json();
            assert.equal(
                (await stranger(`api/groups/${secret.group}/public`)).status,
                404,
                'a private group is no such group',
            );
            const hers = await (await stranger(`api/id/${adaRoot}/groups`)).json();
            assert.ok(
                hers.some((g) => g.group === group && g.name === 'Brie Bunch'),
                'her public group',
            );
            assert.ok(!hers.some((g) => g.group === secret.group), 'never a private one');
        });

        it("a public group's feed answers anyone: full rows, searched and faceted as a persona's shelf is", async () => {
            const stranger = makeFetch(HOST);
            const feed = await (await stranger(`api/groups/${group}/posts`)).json();
            const row = feed.posts.find((p) => p.doc_id === adasPost);
            assert.ok(row, `its post, as a feed row: ${JSON.stringify(feed)}`);
            assert.equal(row.author, adaRoot, 'naming its author');
            const found = await (await stranger(`api/groups/${group}/posts?q=brie`)).json();
            assert.ok(
                found.posts.some((p) => p.doc_id === adasPost),
                'the words find it',
            );
            const none = await (
                await stranger(`api/groups/${group}/posts?q=nothingsaysthis`)
            ).json();
            assert.equal(none.posts.length, 0);
            assert.equal(
                (await stranger(`api/groups/${group}/labels`)).status,
                200,
                'and its facets',
            );

            // A node that held none of ada's posts - eve's, which followed the group - fetches
            // the group's own, and its feed fills.
            let there = [];
            for (let i = 0; i < 20 && !there.some((p) => p.doc_id === adasPost); i++) {
                await beat(HOST_E, 'group-sync');
                there =
                    (await (await makeFetch(HOST_E)(`api/groups/${group}/posts`)).json()).posts ||
                    [];
                if (!there.some((p) => p.doc_id === adasPost))
                    await new Promise((r) => setTimeout(r, 300));
            }
            assert.ok(
                there.some((p) => p.doc_id === adasPost),
                "at another node, from the group's own fetch",
            );
        });
    },
);
