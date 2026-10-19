/*
    Rebroadcasts and groups (plans/GROUPS.md, section 7; Curtis, 2026-10-15, built 2026-10-18).
    Into a group, yes: ada shares cal's public post into the Share Circle, and bea - a member on
    another node, who has never heard of cal - finds it on the group's page and in her feed,
    through ada, its words fetched from cal's road as any rebroadcast's are. Taken back, it goes.
    Out of a group, no: bea's group post can't be shared to everyone, nor back into its own group.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

(HOST_B && HOST_C ? describe : describe.skip)(
    'groups: a public post shared into a group',
    function () {
        this.timeout(600000);

        let ada, adaRoot, bea, beaRoot, cal, calRoot, group, post;

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
        const share = (who, root, doc, author, retract = false) =>
            j(who, `api/identity/${root}/groups/${group}/shares`, { author, doc_id: doc, retract });
        const published = async (who, root, title) => {
            const made = await (
                await j(who, `api/identity/${root}/docs`, { title, body: title, format: 'marquee' })
            ).json();
            const res = await who(`api/identity/${root}/docs/${made.doc_id}/publish`, {
                method: 'POST',
            });
            const text = await res.text();
            assert.equal(res.status, 200, text);
            return JSON.parse(text).post_id;
        };
        // Bea's view, once the lanes have moved: the group's feed and her own.
        const beaSees = async (query = '') => {
            await act(ada, adaRoot, 'sync');
            await act(bea, beaRoot, 'sync');
            await beat(HOST_B, 'fold', beaRoot);
            return (await (await bea(`api/identity/${beaRoot}/feed${query}`)).json()).items || [];
        };

        before(async function () {
            [ada, adaRoot] = await persona('gsada');
            [bea, beaRoot] = await persona('gsbea', HOST_B);
            [cal, calRoot] = await persona('gscal', HOST_C);
            group = (
                await (
                    await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Share Circle' })
                ).json()
            ).group;
            const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
            await act(bea, beaRoot, 'join', {
                invite: token.invite,
                founder: token.founder,
                inviter: token.inviter,
                via: token.via,
            });
            await act(ada, adaRoot, 'sync');

            // Ada follows cal, as she must to have read what she shares.
            const { toBase58 } = await import('../../js/speakable.js');
            const viaCal = toBase58((await (await cal('api/node')).json()).endpoint_id);
            if ((await ada(`api/id/${calRoot}/profile?via=${viaCal}`)).status !== 200) this.skip();
            await j(
                ada,
                `api/identity/${adaRoot}/private/kv/contact:${calRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
            await beat(HOST, 'fold', adaRoot);
            post = await published(cal, calRoot, 'a public potato');
            await pullAndFold(HOST, calRoot);
            const feed = (await (await ada(`api/identity/${adaRoot}/feed`)).json()).items || [];
            assert.ok(
                feed.some((i) => i.doc_id === post),
                "precondition: cal's post reached ada, who follows him",
            );
        });

        it("a member shares a public post into the group: on its page and in each member's feed, through them", async () => {
            const res = await share(ada, adaRoot, post, calRoot);
            assert.equal(res.status, 200, await res.text());
            const mine = await (await ada(`api/identity/${adaRoot}/rebroadcasts`)).json();
            assert.deepEqual(
                mine.groups,
                [{ group, author: calRoot, doc_id: post }],
                'the share button knows where it is',
            );
            assert.ok(
                !mine.items.some((i) => i.doc_id === post),
                'and it is not a share to everyone',
            );

            let picked = [];
            for (let i = 0; i < 10 && !picked.some((x) => x.doc_id === post); i++)
                picked = await beaSees(`?group=${group}`);
            const there = picked.find((x) => x.doc_id === post);
            assert.ok(
                there,
                `on the group's page at bea: ${JSON.stringify(picked.map((x) => x.title))}`,
            );
            assert.equal(there.author, calRoot);
            assert.equal(there.via, adaRoot, 'ada its via');
            assert.ok(!there.group, "a public post, not the group's own");
            assert.ok(
                (await beaSees()).some((x) => x.doc_id === post && x.via === adaRoot),
                "and in bea's feed",
            );
            assert.equal(
                (await bea(`id/${calRoot}/docs/${post}/body`)).status,
                200,
                "its words are cal's, by the public road",
            );
            assert.ok(
                !(
                    (await (await bea(`api/identity/${beaRoot}/feed?group=${group}`)).json())
                        .items || []
                )
                    .filter((x) => !x.group)
                    .some((x) => x.doc_id !== post),
                'the group pick takes in only what was shared into it',
            );
        });

        it("a group's post stays in its group: never to everyone, nor back into it", async () => {
            const made = await (
                await j(bea, `api/identity/${beaRoot}/docs`, {
                    title: 'a group potato',
                    body: 'for the circle',
                    format: 'marquee',
                })
            ).json();
            const posted = await act(bea, beaRoot, 'publish', { doc: made.doc_id });
            let picked = [];
            for (let i = 0; i < 10 && !picked.some((x) => x.doc_id === posted.post); i++) {
                await act(bea, beaRoot, 'sync');
                await act(ada, adaRoot, 'sync');
                await beat(HOST, 'fold', adaRoot);
                picked =
                    (await (await ada(`api/identity/${adaRoot}/feed?group=${group}`)).json())
                        .items || [];
            }
            assert.ok(
                picked.some((x) => x.doc_id === posted.post),
                "precondition: ada has bea's group post",
            );
            const out = await j(ada, `api/identity/${adaRoot}/rebroadcasts`, {
                author: beaRoot,
                doc_id: posted.post,
            });
            assert.equal(out.status, 400, 'not to everyone');
            assert.match(await out.text(), /stays in its group/);
            const back = await share(ada, adaRoot, posted.post, beaRoot);
            assert.equal(back.status, 400, 'nor shared into a group');
            assert.match(await back.text(), /stays in its group/);
            await act(bea, beaRoot, `docs/${posted.post}/retract`);
        });

        it('a share taken back leaves the group and the feeds it reached', async () => {
            const res = await share(ada, adaRoot, post, calRoot, true);
            assert.equal(res.status, 200, await res.text());
            assert.deepEqual(
                (await (await ada(`api/identity/${adaRoot}/rebroadcasts`)).json()).groups,
                [],
            );
            let picked = [{ doc_id: post }];
            for (let i = 0; i < 10 && picked.some((x) => x.doc_id === post); i++)
                picked = await beaSees(`?group=${group}`);
            assert.ok(!picked.some((x) => x.doc_id === post), "gone from the group's page");
            assert.ok(!(await beaSees()).some((x) => x.doc_id === post), "and from bea's feed");
        });
    },
);
