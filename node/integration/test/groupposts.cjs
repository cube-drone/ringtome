/*
    Groups, slice 2 (plans/GROUPS.md, section 7): a group post is a document like any other post -
    a draft published, its picture a media document, edited by publishing again and taken down
    as any post is - on the poster's lane for the group instead of their public chain. Bea posts
    words and a picture to the Potato Bunch; ada's node reads both. Nothing public lists or
    serves them, and a stranger on another node is shown nothing. An edit and a takedown reach
    ada as they would for any post; an owner hides a post without touching it.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C, makeFetch, sql } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)('groups: a group post is a document', function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, dee, deeRoot, group, draft, post, picture;

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
    const page = async (host, who, root) => {
        for (const r of [adaRoot, beaRoot]) await beat(host, 'fold', r);
        const res = await who(`api/identity/${root}/groups/${group}/posts`);
        assert.equal(res.status, 200);
        return (await res.json()).posts;
    };
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
        [ada, adaRoot] = await persona('gpada');
        [bea, beaRoot] = await persona('gpbea', HOST_B);
        [dee, deeRoot] = await persona('gpdee', HOST_C);
        const founded = await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Potato Bunch' });
        group = (await founded.json()).group;
        const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
        await act(bea, beaRoot, 'join', {
            invite: token.invite,
            founder: token.founder,
            inviter: token.inviter,
            via: token.via,
        });
        await sync(ada, adaRoot);
    });

    it("a member's post, with a picture, reaches another member's node and reads there", async () => {
        const pic = await upload(bea, beaRoot, 'spud');
        const created = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'harvest',
                body: `a good year\n\n![spud](/api/identity/${beaRoot}/docs/${pic}/body/spud.avif)`,
                format: 'marquee',
            })
        ).json();
        draft = created;
        post = (await act(bea, beaRoot, 'publish', { doc: created.doc_id })).post;
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);

        const there = (await page(HOST, ada, adaRoot)).find((p) => p.doc === post);
        assert.ok(there, 'the post is on the group page at ada');
        assert.equal(there.title, 'harvest');
        assert.equal(there.author, beaRoot);
        assert.equal(there.media.length, 1);
        [picture] = there.media;
        assert.ok(there.words.includes('a good year'));
        assert.ok(
            there.words.includes(`/api/groups/${group}/docs/${picture}/body/`),
            'the embed points at the group, not at bea',
        );
        const bytes = await ada(`api/groups/${group}/docs/${picture}/body/spud.avif`);
        assert.equal(bytes.status, 200);
        assert.equal(bytes.headers.get('content-type'), 'image/avif');
        assert.ok((await bytes.arrayBuffer()).byteLength > 0);
    });

    it('nothing public lists or serves it, and a stranger is shown nothing', async () => {
        const anon = makeFetch(HOST_B);
        for (const doc of [post, picture]) {
            assert.equal((await anon(`id/${beaRoot}/docs/${doc}/body`)).status, 404);
            // A post's own page falls back to the app's shell for a document it doesn't know -
            // a 200 whatever the id - so the claim is that it carries none of the post.
            const page = await (await anon(`ringtome/user/${beaRoot}/doc/${doc}`)).text();
            assert.ok(!page.includes('harvest') && !page.includes('a good year'));
        }
        const profile = await (await anon(`api/id/${beaRoot}/profile`)).json();
        assert.ok(!(profile.posts || []).some((p) => [post, picture].includes(p.doc_id)));
        // Dee, on a node outside the group, and ada's node's stranger-facing door.
        assert.equal((await dee(`api/groups/${group}/docs/${picture}/body`)).status, 404);
        assert.equal((await dee(`api/identity/${deeRoot}/groups/${group}/posts`)).status, 404);
    });

    it('an edit and a takedown reach the other members, as for any post', async () => {
        await j(
            bea,
            `api/identity/${beaRoot}/docs/${draft.doc_id}`,
            {
                title: 'harvest',
                body: 'a good year, and a better one coming',
                parents: [draft.version],
            },
            'PUT',
        );
        assert.equal(
            (await act(bea, beaRoot, 'publish', { doc: draft.doc_id })).post,
            post,
            'the same post',
        );
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        const edited = (await page(HOST, ada, adaRoot)).find((p) => p.doc === post);
        assert.ok(edited.edited);
        assert.equal(edited.words, 'a good year, and a better one coming');

        const other = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'oops',
                body: 'wrong group',
                format: 'marquee',
            })
        ).json();
        const oops = (await act(bea, beaRoot, 'publish', { doc: other.doc_id })).post;
        await act(bea, beaRoot, `docs/${oops}/retract`);
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        assert.ok(!(await page(HOST, ada, adaRoot)).some((p) => p.doc === oops));
    });

    it("an owner hides a post from the page; it stays its author's", async () => {
        await act(ada, adaRoot, `docs/${post}/hide`, { hidden: true });
        let seen = (await page(HOST, ada, adaRoot)).find((p) => p.doc === post);
        assert.ok(seen.hidden);
        await sync(ada, adaRoot);
        await sync(bea, beaRoot);
        seen = (await page(HOST_B, bea, beaRoot)).find((p) => p.doc === post);
        assert.ok(seen.hidden, "bea's node folds ada's hide too");
        await act(ada, adaRoot, `docs/${post}/hide`, { hidden: false });
        assert.ok(!(await page(HOST, ada, adaRoot)).find((p) => p.doc === post).hidden);
        const res = await j(bea, `api/identity/${beaRoot}/groups/${group}/docs/${post}/hide`, {
            hidden: true,
        });
        assert.equal(res.status, 403, 'only owners hide');
    });

    it("a group post carries its draft's labels, and any member may tag it", async () => {
        const labelsAt = async (host, who, root) =>
            ((await page(host, who, root)).find((p) => p.doc === post) || {}).annotations || [];
        const has = (labels, annotator, key, value) =>
            labels.some((l) => l.annotator === annotator && l.key === key && l.value === value);
        const draftPath = `api/identity/${beaRoot}/docs/${draft.doc_id}/annotations`;
        assert.equal((await bea(`${draftPath}/tags/harvest`, { method: 'PUT' })).status, 200);
        assert.equal(
            (await j(bea, `${draftPath}/fields/description`, { value: 'what we dug up' }, 'PUT'))
                .status,
            200,
        );
        await act(bea, beaRoot, 'publish', { doc: draft.doc_id });
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        let labels = await labelsAt(HOST, ada, adaRoot);
        assert.ok(
            has(labels, beaRoot, 'tag', 'harvest'),
            `the draft's tag: ${JSON.stringify(labels)}`,
        );
        assert.ok(has(labels, beaRoot, 'description', 'what we dug up'), 'its description');
        assert.ok(has(labels, beaRoot, 'tag', 'micro'), 'its length, as any post says it');
        assert.ok(
            !has(labels, beaRoot, 'tag', 'image'),
            'and no picture, since the edit dropped it',
        );

        // Ada tags it, three times: two stand to a person, as on any post.
        for (const tag of ['spuds', 'roots', 'zesty']) {
            await act(ada, adaRoot, `docs/${post}/labels`, { value: tag, present: true });
        }
        await sync(ada, adaRoot);
        await sync(bea, beaRoot);
        labels = await labelsAt(HOST_B, bea, beaRoot);
        assert.ok(has(labels, adaRoot, 'tag', 'roots') && has(labels, adaRoot, 'tag', 'spuds'));
        assert.ok(!has(labels, adaRoot, 'tag', 'zesty'), 'the third falls');

        // A tag the draft drops is taken back at the next publish.
        assert.equal((await bea(`${draftPath}/tags/harvest`, { method: 'DELETE' })).status, 200);
        await act(bea, beaRoot, 'publish', { doc: draft.doc_id });
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        labels = await labelsAt(HOST, ada, adaRoot);
        assert.ok(!has(labels, beaRoot, 'tag', 'harvest'), 'retracted');
        assert.ok(has(labels, adaRoot, 'tag', 'spuds'), "and ada's own tags stay");
    });

    it("a group post is in its members' feeds, naming its group, and a group pick shows only it", async () => {
        const feed = async (who, root, query = '') =>
            (await (await who(`api/identity/${root}/feed${query}`)).json()).items || [];
        // Ada also has a public post of her own, which a group pick leaves out.
        const pub = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title: 'out loud',
                body: 'hello world',
                format: 'marquee',
            })
        ).json();
        assert.equal(
            (await ada(`api/identity/${adaRoot}/docs/${pub.doc_id}/publish`, { method: 'POST' }))
                .status,
            200,
        );
        await beat(HOST, 'fold', adaRoot);

        const mine = await feed(ada, adaRoot);
        const there = mine.find((i) => i.doc_id === post);
        assert.ok(
            there,
            `bea's group post is in ada's feed: ${JSON.stringify(mine.map((i) => i.title))}`,
        );
        assert.deepEqual(
            there.group,
            { id: group, name: 'Potato Bunch', owner: true },
            'naming its group, and that ada owns it',
        );
        assert.equal(there.author, beaRoot);
        assert.ok(
            there.annotations.some((a) => a.annotator === adaRoot && a.value === 'spuds'),
            'wearing its labels',
        );
        assert.ok(
            mine.some((i) => !i.group && i.title === 'out loud'),
            'beside her public post',
        );

        const picked = await feed(ada, adaRoot, `?group=${group}`);
        assert.ok(picked.some((i) => i.doc_id === post));
        assert.ok(
            picked.every((i) => i.group && i.group.id === group),
            'the group pick shows only it',
        );
        const left = await feed(ada, adaRoot, `?not_group=${group}`);
        assert.ok(!left.some((i) => i.doc_id === post), 'and leaving it out drops it');
        assert.ok(left.some((i) => i.title === 'out loud'));
        const tagged = await feed(ada, adaRoot, '?tag=spuds');
        assert.ok(
            tagged.some((i) => i.doc_id === post),
            'a tag picks it like any post',
        );
        // The group page's own strip (2026-10-16): the group pick with any other beside it.
        const within = await feed(ada, adaRoot, `?group=${group}&tag=spuds`);
        assert.ok(
            within.some((i) => i.doc_id === post),
            'a tag within the group picks it',
        );
        assert.ok(
            within.every((i) => i.group && i.group.id === group),
            'and only the group',
        );
        assert.ok(
            !(await feed(ada, adaRoot, `?group=${group}&not_tag=spuds`)).some(
                (i) => i.doc_id === post,
            ),
            'and the tag left out drops it there',
        );

        assert.ok(
            (await feed(bea, beaRoot)).some((i) => i.doc_id === post),
            "and it's in bea's feed",
        );
        assert.ok(!(await feed(dee, deeRoot)).some((i) => i.doc_id === post), "never a stranger's");
    });

    it('a group post is a row of the one feed journal: the public road leaves it be, and every view sees it', async () => {
        // ONE_FEED.md slice 3: no journal of its own any more.
        const feed = async (query = '') =>
            (await (await ada(`api/identity/${adaRoot}/feed${query}`)).json()).items || [];
        const inIt = async (query) => (await feed(query)).some((i) => i.doc_id === post);
        const gone = await sql("SELECT name FROM sqlite_master WHERE name = 'group_journal'");
        assert.equal(gone.rows.length, 0, 'the separate journal is gone');
        // Following bea and then not: the unfollow excises bea's public rows, never her group post.
        const interest = (level) =>
            ada(`api/identity/${adaRoot}/private/kv/contact:${beaRoot}/interest`, {
                method: 'PUT',
                body: JSON.stringify({ value: level }),
            });
        await interest('medium');
        await beat(HOST, 'fold', adaRoot);
        await interest('none');
        await beat(HOST, 'fold', adaRoot);
        assert.ok(await inIt(`?group=${group}`), "an unfollow leaves a fellow member's group post");
        // The forced reconcile of bea's public lane - what a boot runs - finds it on no shelf of
        // hers, and leaves it, since it isn't a public row.
        await beat(HOST, 'fold', beaRoot);
        assert.ok(await inIt(`?group=${group}`), 'the reconcile leaves it too');
        // Every view of the feed, with no chip picked.
        assert.ok(await inIt('?sort=hot'), 'hot has it');
        assert.ok(await inIt('?sort=best'), 'best has it');
        const cloud = await (await ada(`api/identity/${adaRoot}/feed/labels`)).json();
        assert.ok(
            JSON.stringify(cloud.tags || []).includes('spuds'),
            `the tag cloud counts its tag: ${JSON.stringify(cloud.tags)}`,
        );
        const named = (await feed()).find((i) => i.doc_id === post);
        assert.equal(named.group.name, 'Potato Bunch', 'its card names its group, by id');
        // The strip's groups row (Curtis, 2026-10-16): each group's posts, by name; and a group
        // picked narrows the other rows' counts as any pick does.
        const row = (cloud.groups || []).find((g) => g.value === group);
        assert.ok(
            row && row.count >= 1,
            `the groups row counts it: ${JSON.stringify(cloud.groups)}`,
        );
        assert.equal(row.name, 'Potato Bunch');
        const labelsFor = async (query) =>
            JSON.stringify(
                (await (await ada(`api/identity/${adaRoot}/feed/labels${query}`)).json()).tags ||
                    [],
            );
        assert.ok((await labelsFor(`?group=${group}`)).includes('spuds'), 'picked, its tags count');
        assert.ok(
            !(await labelsFor(`?not_group=${group}`)).includes('spuds'),
            'left out, they do not',
        );
    });

    it("a group post has a page of its own, for members alone, and its card wears an owner's hide", async () => {
        const item = async (who, root) => {
            const res = await who(`api/identity/${root}/groups/${group}/posts/${post}`);
            return res.status === 200 ? (await res.json()).item : res.status;
        };
        const adas = await item(ada, adaRoot);
        assert.equal(adas.doc_id, post, `ada's node answers the post: ${JSON.stringify(adas)}`);
        assert.equal(adas.author, beaRoot);
        assert.ok(adas.group.owner, 'and offers its owner the hide');
        const beas = await item(bea, beaRoot);
        assert.equal(beas.doc_id, post);
        assert.ok(!beas.group.owner, 'but not a member who owns nothing');
        assert.equal(await item(dee, deeRoot), 404, 'a stranger is told there is no such post');

        const inFeed = async (who, root) =>
            (
                (await (await who(`api/identity/${root}/feed?group=${group}`)).json()).items || []
            ).find((i) => i.doc_id === post);
        await act(ada, adaRoot, `docs/${post}/hide`, { hidden: true });
        assert.ok((await inFeed(ada, adaRoot)).group.hidden, "ada's card says it's hidden");
        assert.ok((await item(ada, adaRoot)).group.hidden, 'and so does its page');
        await sync(ada, adaRoot);
        let beaSees;
        for (let i = 0; i < 20; i++) {
            await sync(bea, beaRoot);
            beaSees = await inFeed(bea, beaRoot);
            if (beaSees && beaSees.group.hidden) break;
            await wait(300);
        }
        assert.ok(beaSees && beaSees.group.hidden, 'its author still has it, marked hidden');
        await act(ada, adaRoot, `docs/${post}/hide`, { hidden: false });
        assert.ok(!(await inFeed(ada, adaRoot)).group.hidden, 'shown again, the mark goes');
        await sync(ada, adaRoot);
    });

    it('reads every post at once: a page full of cards, each asking for its words together', async () => {
        // A group's page asks for every card's words at once, beside the visit's sync. Each body
        // request used to refold the group, and refolds running together failed one another: the
        // author's own posts read "these words haven't reached this computer" (2026-10-16).
        const asks = [act(bea, beaRoot, 'sync')];
        for (let i = 0; i < 12; i++)
            asks.push(bea(`api/groups/${group}/docs/${post}/body`).then((r) => r.status));
        const statuses = (await Promise.all(asks)).slice(1);
        assert.deepEqual(
            statuses.filter((s) => s !== 200),
            [],
            `every one answered: ${statuses.join(', ')}`,
        );
    });

    it("a group post's labels are in the one label memo, marked with its group", async () => {
        // ONE_FEED.md slice 4: what the group's fold counts is kept where every label is.
        const memo = async () =>
            (
                await sql(
                    `SELECT annotator, key, value, lower(hex(group_id)) AS grp FROM doc_annotations
                     WHERE target_doc = '${post}' AND key = 'tag'`,
                )
            ).rows;
        await sync(ada, adaRoot);
        let rows = await memo();
        const spuds = rows.find((r) => r.value === 'spuds' && r.annotator === adaRoot);
        assert.ok(spuds, `ada's tag is in the memo: ${JSON.stringify(rows)}`);
        assert.equal(spuds.grp, group.toLowerCase(), 'marked as the group post it is');
        await act(ada, adaRoot, `docs/${post}/labels`, { value: 'memoed', present: true });
        assert.ok(
            (await memo()).some((r) => r.value === 'memoed'),
            'a new tag lands there',
        );
        await act(ada, adaRoot, `docs/${post}/labels`, { value: 'memoed', present: false });
        rows = await memo();
        assert.ok(!rows.some((r) => r.value === 'memoed'), 'and leaves when taken back');
    });

    it("a group's tables are written again only when its lanes move", async () => {
        // ONE_FEED.md slice 1: the fold is kept by the group's stamp, and what it derives - who the
        // door opens to, the feed's journal - is rewritten only when the lanes moved since.
        const hexGroup = group.toLowerCase();
        const stamps = async () =>
            (
                await sql(
                    `SELECT lanes_seq, derived_seq FROM group_stamps WHERE hex(group_id) = upper('${hexGroup}')`,
                )
            ).rows[0];
        const noted = async () =>
            (
                await sql(
                    `SELECT MAX(noted) AS noted FROM feed_journal WHERE hex(group_id) = upper('${hexGroup}')`,
                )
            ).rows[0].noted;
        await beat(HOST, 'group-sync');
        const before = await stamps();
        const wrote = await noted();
        assert.equal(
            before.derived_seq,
            before.lanes_seq,
            `derived from the lanes as they stand: ${JSON.stringify(before)}`,
        );
        // Nothing new: a sync, the beat, and every read the page makes leave the tables alone.
        await sync(ada, adaRoot);
        await beat(HOST, 'group-sync');
        await page(HOST, ada, adaRoot);
        assert.deepEqual(await stamps(), before, 'the stamp stands');
        assert.equal(await noted(), wrote, 'and the journal was not written again');
        // A label is an entry on ada's lane: the stamp moves, and the tables follow it.
        await act(ada, adaRoot, `docs/${post}/labels`, { value: 'stamped', present: true });
        const after = await stamps();
        assert.ok(after.lanes_seq > before.lanes_seq, 'the lanes moved');
        assert.equal(after.derived_seq, after.lanes_seq, 'and the tables were written from them');
        assert.ok((await noted()) > wrote, 'the journal again, in place');
        await act(ada, adaRoot, `docs/${post}/labels`, { value: 'stamped', present: false });
    });

    it("a post's own page is there the moment it's posted, where the composer sends its author", async () => {
        // The feed's composer goes to the new post's page (2026-10-16), drawing it from what it
        // knows until the node answers - and the node answers at once: publishing drains the
        // poster's fold, which writes the journal row the page reads. No sync, no beat between.
        const d = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: '',
                body: 'straight to my post',
                format: 'marquee',
            })
        ).json();
        const { post: fresh } = await act(bea, beaRoot, 'publish', { doc: d.doc_id });
        const res = await bea(`api/identity/${beaRoot}/groups/${group}/posts/${fresh}`);
        assert.equal(res.status, 200, await res.clone().text());
        assert.equal((await res.json()).item.doc_id, fresh);
        await act(bea, beaRoot, `docs/${fresh}/retract`);
    });

    it("pins: a member's, an owner's above it, and who may take each down", async () => {
        // Slice 4d (Curtis, 2026-10-15/16): owners and members both pin any post; an owner's pin
        // is the owners' layer, shown first; owners unpin anything; members unpin members' pins.
        const pinOf = async (who, root) =>
            (
                (
                    (await (await who(`api/identity/${root}/feed?group=${group}`)).json()).items ||
                    []
                ).find((i) => i.doc_id === post) || {}
            ).group?.pinned;
        const settle = async (who, root, want) => {
            let got;
            for (let i = 0; i < 20; i++) {
                await sync(ada, adaRoot);
                await sync(bea, beaRoot);
                got = await pinOf(who, root);
                if (got === want) break;
                await wait(300);
            }
            return got;
        };
        // Bea, a member, pins it - her own post, though any would do.
        assert.equal(
            (await act(bea, beaRoot, `docs/${post}/pin`, { pinned: true })).pinned,
            'member',
        );
        assert.equal(await settle(ada, adaRoot, 'member'), 'member', "ada's node has bea's pin");
        // Ada, an owner, pins it too: the owners' layer holds it.
        assert.equal(
            (await act(ada, adaRoot, `docs/${post}/pin`, { pinned: true })).pinned,
            'owner',
        );
        assert.equal(await settle(bea, beaRoot, 'owner'), 'owner', "bea's node: an owner's pin");
        // Bea can't take an owner's pin down.
        const refused = await j(bea, `api/identity/${beaRoot}/groups/${group}/docs/${post}/pin`, {
            pinned: false,
        });
        assert.equal(refused.status, 403, 'only an owner takes down an owner pin');
        // Ada takes every pin on it down, the member's as well.
        assert.equal((await act(ada, adaRoot, `docs/${post}/pin`, { pinned: false })).pinned, null);
        assert.equal(await settle(bea, beaRoot, undefined), undefined, 'unpinned everywhere');
        // A stranger pins nothing: the group isn't theirs to see.
        const stranger = await j(dee, `api/identity/${deeRoot}/groups/${group}/docs/${post}/pin`, {
            pinned: true,
        });
        assert.equal(stranger.status, 404);
    });

    it("the group's face: owners set its name, bio, picture and banner, and anyone may ask for it", async () => {
        // Curtis, 2026-10-16: a picture, a banner and a bio, as a person has - owners only, owner
        // settings on their lanes - shown to anyone who asks, since an invitee needs to know them.
        const roster = async (who, root) =>
            await (await who(`api/identity/${root}/groups/${group}`)).json();
        const face = async (host) =>
            await (await makeFetch(host)(`api/groups/${group}/face`)).json();
        const setFace = (who, root, which) => {
            const form = new FormData();
            form.append('image', new Blob([makePng(48, 32)], { type: 'image/png' }), 'face.png');
            return who(`api/identity/${root}/groups/${group}/face/${which}`, {
                method: 'POST',
                body: form,
                file: true,
            });
        };
        // A member who isn't an owner can't, either way.
        assert.equal((await setFace(bea, beaRoot, 'picture')).status, 403);
        assert.equal(
            (
                await j(bea, `api/identity/${beaRoot}/groups/${group}/settings`, {
                    description: 'mine',
                })
            ).status,
            403,
        );
        // The owner does.
        let r = await act(ada, adaRoot, 'settings', { description: 'we grow potatoes' });
        assert.equal(r.description, 'we grow potatoes');
        const res = await setFace(ada, adaRoot, 'picture');
        assert.equal(res.status, 200, await res.clone().text());
        r = await res.json();
        assert.match(r.picture || '', /^\/api\/groups\/[0-9a-f]+\/face\/[0-9a-f]{32}$/);
        r = await (await setFace(ada, adaRoot, 'banner')).json();
        assert.ok(r.banner && r.banner !== r.picture, 'a banner of its own');
        const { picture, banner } = r;

        // Anyone may ask: no session, the face and nothing more.
        const told = await face(HOST);
        assert.deepEqual(
            told,
            { group, name: 'Potato Bunch', description: 'we grow potatoes', picture, banner },
            'the face, to a stranger',
        );
        const bytes = await makeFetch(HOST)(picture.replace(/^\//, ''));
        assert.equal(bytes.status, 200);
        assert.equal(bytes.headers.get('content-type'), 'image/avif');
        assert.equal((await makeFetch(HOST)(`${picture.replace(/^\//, '')}/thumb`)).status, 200);

        // It reaches the other member's node, bytes and all, as the group's pictures do.
        await sync(ada, adaRoot);
        await sync(bea, beaRoot);
        assert.equal((await roster(bea, beaRoot)).picture, picture);
        assert.equal((await face(HOST_B)).description, 'we grow potatoes');
        assert.equal((await makeFetch(HOST_B)(banner.replace(/^\//, ''))).status, 200);
        // A node that doesn't hold the group knows nothing of it.
        assert.equal((await makeFetch(HOST_C)(`api/groups/${group}/face`)).status, 404);

        // The face is never a post.
        const docOf = (url) => url.split('/').pop();
        const posts = (await page(HOST, ada, adaRoot)).map((p) => p.doc);
        assert.ok(
            !posts.includes(docOf(picture)) && !posts.includes(docOf(banner)),
            'neither picture is listed as a post',
        );

        // A new picture replaces the old, whose address then answers nothing; cleared, none.
        const next = (await (await setFace(ada, adaRoot, 'picture')).json()).picture;
        assert.notEqual(next, picture);
        assert.equal((await makeFetch(HOST)(picture.replace(/^\//, ''))).status, 404);
        const posted = (await page(HOST, ada, adaRoot)).map((p) => p.doc);
        assert.ok(!posted.includes(docOf(picture)), 'the replaced picture is no post either');
        const cleared = await ada(`api/identity/${adaRoot}/groups/${group}/face/picture`, {
            method: 'DELETE',
        });
        assert.equal(cleared.status, 200);
        assert.equal((await cleared.json()).picture, null);
        assert.equal((await face(HOST)).picture, null);
        // The rename rides the same road.
        r = await act(ada, adaRoot, 'settings', { name: 'Potato Bunch' });
        assert.equal(r.name, 'Potato Bunch');
    });

    it('a dated draft posts under its date, with comments off if asked', async () => {
        const made = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'last spring',
                body: 'planting',
                format: 'marquee',
            })
        ).json();
        assert.equal(
            (
                await j(
                    bea,
                    `api/identity/${beaRoot}/docs/${made.doc_id}/annotations/fields/display_date`,
                    { value: '2020-05-01' },
                    'PUT',
                )
            ).status,
            200,
        );
        const { post: dated } = await act(bea, beaRoot, 'publish', {
            doc: made.doc_id,
            settled: true,
            tz_offset_min: 0,
        });
        const there = (await page(HOST_B, bea, beaRoot)).find((p) => p.doc === dated);
        assert.ok(there, 'posted');
        assert.ok(
            there.posted_ms >= Date.parse('2020-04-30') &&
                there.posted_ms < Date.parse('2020-05-03'),
            `under its claimed date: ${new Date(there.posted_ms).toISOString()}`,
        );
        assert.equal(there.settled, true, 'comments off');
    });

    it('a future date schedules the post, and the sweep posts it to the group on its day', async () => {
        const made = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'next year',
                body: 'harvest festival',
                format: 'marquee',
            })
        ).json();
        await j(
            bea,
            `api/identity/${beaRoot}/docs/${made.doc_id}/annotations/fields/display_date`,
            { value: '2031-01-01' },
            'PUT',
        );
        const answer = await act(bea, beaRoot, 'publish', { doc: made.doc_id, tz_offset_min: 0 });
        assert.ok(!answer.post, 'nothing posted yet');
        assert.ok(answer.scheduled_for > Date.now(), 'scheduled');
        const named = async () =>
            (await page(HOST_B, bea, beaRoot)).some((p) => p.title === 'next year');
        assert.equal(await named(), false, 'not on the page before its day');

        const ring = (at) =>
            bea('test/beat', {
                method: 'POST',
                body: JSON.stringify({ pass: 'publish-due', root: beaRoot, at_ms: at }),
            });
        assert.equal((await ring(undefined)).status, 200);
        assert.equal(await named(), false, 'the sweep leaves it alone before its day');
        assert.equal((await ring(answer.scheduled_for + 1)).status, 200);
        assert.equal(await named(), true, 'posted on its day');
        const where = await (
            await bea(`api/identity/${beaRoot}/docs/${made.doc_id}/groups`)
        ).json();
        assert.deepEqual(
            where.map((w) => w.group),
            [group],
            'and the draft knows where it went',
        );
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        assert.ok(
            (await page(HOST, ada, adaRoot)).some((p) => p.title === 'next year'),
            'ada has it',
        );
    });

    it('a member mentioned in a group post, or whose post is labelled, hears it in the bell', async () => {
        const { speakable } = await import('../../js/speakable.js');
        const bell = async (who, root, kind, doc) =>
            ((await (await who(`api/identity/${root}/notifications`)).json()).items || []).filter(
                (i) => i.kind === kind && i.doc_id === doc,
            );
        const until = async (host, who, root, kind, doc, test) => {
            let rows = [];
            for (let i = 0; i < 20; i++) {
                await sync(ada, adaRoot);
                await sync(bea, beaRoot);
                for (const r of [adaRoot, beaRoot]) await beat(host, 'fold', r);
                rows = await bell(who, root, kind, doc);
                if (test(rows)) return rows;
                await wait(300);
            }
            return rows;
        };
        // Bea names ada, a member, and dee, who isn't one.
        const words = (names) =>
            `dig day\n\n${names.map((r) => `:::user id=/id/${speakable(r)}:::`).join('\n\n')}\n`;
        const dig = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'dig day',
                body: words([adaRoot, deeRoot]),
                format: 'marquee',
            })
        ).json();
        const digPost = (await act(bea, beaRoot, 'publish', { doc: dig.doc_id })).post;
        let rows = await until(HOST, ada, adaRoot, 'group-mentioned', digPost, (r) => r.length);
        assert.equal(rows.length, 1, "the mention rang ada's bell");
        assert.equal(rows[0].author, beaRoot);
        assert.equal(rows[0].group, group);
        assert.equal(rows[0].group_name, 'Potato Bunch');
        assert.equal(rows[0].doc_title, 'dig day', "its title, off ada's own journal row");
        assert.ok(!rows[0].stranger, 'folded, never an envelope');
        assert.equal(
            (await bell(dee, deeRoot, 'group-mentioned', digPost)).length,
            0,
            'a stranger named in a group post hears nothing of it',
        );

        // Ada labels bea's post: bea hears of it, with the words.
        await act(ada, adaRoot, `docs/${digPost}/labels`, { value: 'muddy', present: true });
        rows = await until(HOST_B, bea, beaRoot, 'group-tagged', digPost, (r) => r.length);
        assert.equal(rows.length, 1, "the label rang bea's bell");
        assert.equal(rows[0].author, adaRoot);
        assert.ok(rows[0].detail.includes('muddy'), JSON.stringify(rows[0]));
        assert.equal(rows[0].group, group);
        // Taken back, the row leaves.
        await act(ada, adaRoot, `docs/${digPost}/labels`, { value: 'muddy', present: false });
        rows = await until(HOST_B, bea, beaRoot, 'group-tagged', digPost, (r) => !r.length);
        assert.equal(rows.length, 0, 'the label taken back, the row with it');

        // An edit that drops the card takes the mention back, and ada's row with it.
        await j(
            bea,
            `api/identity/${beaRoot}/docs/${dig.doc_id}`,
            { title: 'dig day', body: words([]), parents: [dig.version] },
            'PUT',
        );
        await act(bea, beaRoot, 'publish', { doc: dig.doc_id });
        rows = await until(HOST, ada, adaRoot, 'group-mentioned', digPost, (r) => !r.length);
        assert.equal(rows.length, 0, 'the card dropped, the row with it');
    });
});
