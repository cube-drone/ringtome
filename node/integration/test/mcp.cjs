/*
    The Model Context Protocol at /mcp (mcp.rs, plans/MCP.md): Horse Drawing Tycoon 2 for AI
    agents. An AI client connects with an API key - never a cookie - and calls tools that are
    requests to the node's own doors, as that key. The node keeps no sessions and answers in plain
    JSON, under both lifecycles the protocol has had: the `initialize` handshake (2025-11-25 and
    before), and from 2026-07-28 none at all, every request carrying its own version.

    The reading tools (mcp/read.rs, Slice 1) answer in cards shaped for a model: a post's address
    as `author/doc`, the author named once, other people's words fenced as theirs. Their unlock
    gates can't be seen here - the rig hands every persona every unlock (bank.rs
    `everything_unlocked`) - so the gate's decision is mcp.rs's unit test, and was watched refuse
    on a node keeping its locks (HISTORY, 2026-10-06).
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What every MCP client sends with a request: it takes either answer, JSON or an event stream.
const ACCEPT = 'application/json, text/event-stream';
const HANDSHAKE_VERSION = '2025-11-25';
const STATELESS_VERSION = '2026-07-28';

// One JSON-RPC message to /mcp. `as` is a fetch: a program's carries a key, the signed-in
// browser's only its cookie.
const rpc = (as, message, headers = {}) =>
    as('mcp', {
        method: 'POST',
        headers: { Accept: ACCEPT, ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    });
// A program with no cookie at all - only the key.
const program = (k) => {
    const bare = makeFetch();
    return (path, opts = {}) =>
        bare(path, {
            ...opts,
            headers: { ...(opts.headers || {}), Authorization: `Bearer ${k}` },
        });
};
const initialize = (as) =>
    rpc(as, {
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: HANDSHAKE_VERSION,
            capabilities: {},
            clientInfo: { name: 'mcp.cjs', version: '0' },
        },
    });
// A request the handshake way: after `initialize`, every request names the version agreed.
const request = async (as, method, params) => {
    const r = await rpc(
        as,
        { id: 3, method, params },
        { 'MCP-Protocol-Version': HANDSHAKE_VERSION },
    );
    assert.equal(r.status, 200, await r.clone().text());
    const answer = await r.json();
    assert.ok(answer.result, JSON.stringify(answer));
    return answer.result;
};
const callTool = (as, name, args = {}) => request(as, 'tools/call', { name, arguments: args });
// A tool's answer as the agent reads it: its JSON, or - when the tool stopped - its words.
const tool = async (as, name, args = {}) => {
    const result = await callTool(as, name, args);
    const text = result.content[0].text;
    return result.isError ? { stopped: text } : JSON.parse(text);
};

// A user with a persona and an API key.
const keyed = async (prefix) => {
    const me = await makeUserFetch({ prefix });
    const root = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
    const made = await j(me, 'api/auth/keys', { name: 'my agent' });
    assert.equal(made.status, 200, await made.clone().text());
    const { key } = await made.json();
    return { me, root, key, agent: program(key) };
};

describe('MCP: an AI agent, with your API key', function () {
    this.timeout(120000);

    let me, root, key;

    before(async () => {
        ({ me, root, key } = await keyed('mcpuser'));
    });

    it('takes an API key and nothing else: no key, a cookie alone, an unknown key - refused', async () => {
        assert.equal((await initialize(makeFetch())).status, 401, 'nobody');
        assert.equal(
            (await initialize(me)).status,
            401,
            'a signed-in browser is not an MCP client: the cookie is never read',
        );
        assert.equal((await initialize(program(`rtk_${'0'.repeat(64)}`))).status, 401, 'unknown');
    });

    it('answers the handshake in plain JSON, with no session, as Horse Drawing Tycoon 2', async () => {
        const r = await initialize(program(key));
        assert.equal(r.status, 200, await r.clone().text());
        assert.match(r.headers.get('content-type'), /^application\/json/);
        assert.equal(r.headers.get('mcp-session-id'), null, 'stateless: no session is kept');
        const { result } = await r.json();
        assert.equal(result.protocolVersion, HANDSHAKE_VERSION);
        assert.equal(result.serverInfo.name, 'ringtome', "the protocol's name for itself");
        assert.equal(result.serverInfo.title, 'Horse Drawing Tycoon 2', 'what a person sees');
        assert.ok(result.instructions, 'and a word for the model on where to start');
    });

    it('lists its tools: the readers marked read-only, the bell marked a write that repeats', async () => {
        const { tools } = await request(program(key), 'tools/list');
        const by = Object.fromEntries(tools.map((t) => [t.name, t]));
        for (const name of [
            'whoami',
            'read_feed',
            'read_post',
            'read_profile',
            'read_notifications',
            'list_documents',
            'read_document',
        ]) {
            assert.ok(by[name], `${name} in ${Object.keys(by)}`);
            assert.equal(by[name].annotations.readOnlyHint, true, `${name} only looks`);
        }
        const mark = by.mark_notifications_seen.annotations;
        assert.equal(mark.readOnlyHint, false, 'marking seen is a write');
        assert.equal(mark.destructiveHint, false, 'and destroys nothing');
        assert.equal(mark.idempotentHint, true);
        assert.ok(by.read_feed.inputSchema.properties.persona, 'a persona may be named');
    });

    it("whoami: the key's account and its personas, through the node's own doors", async () => {
        const who = await tool(program(key), 'whoami');
        assert.equal(who.username, me.account.username);
        assert.deepEqual(
            who.personas.map((p) => p.root),
            [root],
        );
        assert.equal(who.personas[0].standing, 'active');
        assert.match(who.personas[0].horsebucks, /^-?[\d,]+\.\d\d$/, 'a balance, in HorseBucks');
    });

    it('answers 2026-07-28 with no handshake: the request carries its own version', async () => {
        const r = await rpc(
            program(key),
            {
                id: 7,
                method: 'tools/call',
                params: {
                    name: 'whoami',
                    arguments: {},
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': STATELESS_VERSION,
                        'io.modelcontextprotocol/clientInfo': { name: 'mcp.cjs', version: '0' },
                        'io.modelcontextprotocol/clientCapabilities': {},
                    },
                },
            },
            {
                'MCP-Protocol-Version': STATELESS_VERSION,
                'Mcp-Method': 'tools/call',
                'Mcp-Name': 'whoami',
            },
        );
        assert.equal(r.status, 200, await r.clone().text());
        const { result } = await r.json();
        assert.equal(JSON.parse(result.content[0].text).username, me.account.username);
    });

    it('hands over the guide: as a resource, and as a page anyone may read', async () => {
        const { resources } = await request(program(key), 'resources/list');
        const guide = resources.find((r) => r.name === 'guide');
        assert.ok(guide, JSON.stringify(resources));
        const { contents } = await request(program(key), 'resources/read', { uri: guide.uri });
        assert.match(contents[0].text, /^# Horse Drawing Tycoon 2, for an agent/);

        const page = await makeFetch()('mcp/guide.md');
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /^text\/markdown/);
        assert.equal(await page.text(), contents[0].text, 'the same words');
    });

    it('stops at once when the key is revoked', async () => {
        const keys = (await (await me('api/auth/keys')).json()).keys;
        const mine = keys.find((k) => k.name === 'my agent');
        assert.equal((await me(`api/auth/keys/${mine.id}`, { method: 'DELETE' })).status, 200);
        assert.equal((await initialize(program(key))).status, 401);
    });
});

describe('MCP: reading, as a persona', function () {
    this.timeout(120000);

    let me, root, agent, name, postAddress, noteId;

    before(async () => {
        ({ me, root, agent } = await keyed('mcpreader'));
        name = `Reader ${Date.now()}`;
        assert.equal(
            (await j(me, `api/identity/${root}/profile`, { field: 'name', value: name })).status,
            200,
        );
        // A note kept, and a post made of another - words with a horse in them, to search for.
        const note = await (
            await j(me, `api/identity/${root}/docs`, {
                title: 'oats',
                body: 'a private list: oats, hay, apples',
                format: 'marquee',
            })
        ).json();
        noteId = note.doc_id;
        const draft = await (
            await j(me, `api/identity/${root}/docs`, {
                title: 'gallop',
                body: 'the palomino galloped across the paddock',
                format: 'marquee',
            })
        ).json();
        const published = await j(me, `api/identity/${root}/docs/${draft.doc_id}/publish`, {});
        assert.equal(published.status, 200, await published.clone().text());
        postAddress = `${root}/${(await published.json()).post_id}`;
    });

    it("read_feed: the persona's own post, as a card, its words fenced as theirs", async () => {
        let card;
        for (let i = 0; i < 30 && !card; i++) {
            const feed = await tool(agent, 'read_feed');
            assert.ok(!feed.stopped, feed.stopped);
            card = feed.posts.find((p) => p.post === postAddress);
            if (!card) await wait(300);
        }
        assert.ok(card, `${postAddress} in the feed`);
        assert.deepEqual(card.author, { root, name });
        assert.equal(card.mine, true);
        assert.match(card.published, /^\d{4}-\d\d-\d\dT/, 'a date, not milliseconds');
        assert.deepEqual(card.words, {
            author: name,
            text: 'the palomino galloped across the paddock',
        });

        const found = await tool(agent, 'read_feed', { search: 'palomino' });
        assert.ok(
            found.posts.some((p) => p.post === postAddress),
            'and a search finds it',
        );
        const none = await tool(agent, 'read_feed', { kind: 'horse' });
        assert.match(none.stopped, /isn't a kind of post/);
    });

    it('read_post: the whole post by its address, or by a link holding it', async () => {
        const read = await tool(agent, 'read_post', { post: postAddress });
        assert.equal(read.post.post, postAddress);
        assert.equal(read.post.words.text, 'the palomino galloped across the paddock');
        assert.deepEqual(read.replies, []);

        const [author, doc] = postAddress.split('/');
        const byLink = await tool(agent, 'read_post', {
            post: `https://horses.example/id/${author}/docs/${doc}/body`,
        });
        assert.equal(byLink.post.post, postAddress);
        assert.match((await tool(agent, 'read_post', { post: 'hello' })).stopped, /address/);
    });

    it("read_profile: someone's page - their name, their posts", async () => {
        const page = await tool(agent, 'read_profile', { who: root });
        assert.deepEqual(page.who, { root, name });
        assert.equal(page.profile.fields.name, name);
        assert.ok(page.posts.some((p) => p.post === postAddress));
        assert.match((await tool(agent, 'read_profile', { who: 'nobody' })).stopped, /find/);
    });

    it('the documents: listed with their kind, and a note read whole, fenced', async () => {
        const listed = await tool(agent, 'list_documents', { kind: 'note' });
        const oats = listed.documents.find((d) => d.document === noteId);
        assert.ok(oats, JSON.stringify(listed));
        assert.equal(oats.kind, 'note');
        assert.equal(oats.title, 'oats');

        const read = await tool(agent, 'read_document', { document: noteId });
        assert.deepEqual(read.words, { author: name, text: 'a private list: oats, hay, apples' });
        assert.match((await tool(agent, 'list_documents', { kind: 'poem' })).stopped, /kind/);
    });

    it('the bell: read without marking, and marked seen only when asked', async () => {
        const bell = await tool(agent, 'read_notifications');
        assert.ok(Array.isArray(bell.notifications), JSON.stringify(bell));
        const marked = await tool(agent, 'mark_notifications_seen');
        assert.equal(typeof marked.marked_seen, 'number');
        assert.equal(
            (await tool(agent, 'mark_notifications_seen')).marked_seen,
            0,
            'nothing left to mark',
        );
    });

    it('one connection reaches every persona: named, or asked which', async () => {
        const second = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
        const ask = await tool(agent, 'read_notifications');
        assert.match(ask.stopped, /several personas/, 'two personas, none named: which?');
        assert.ok(ask.stopped.includes(root) && ask.stopped.includes(second), ask.stopped);

        const byName = await tool(agent, 'read_notifications', { persona: name.toUpperCase() });
        assert.equal(byName.persona.root, root, 'by name, any case');
        const byRoot = await tool(agent, 'read_notifications', { persona: second });
        assert.equal(byRoot.persona.root, second, 'by root');
        assert.match(
            (await tool(agent, 'read_notifications', { persona: 'Pony' })).stopped,
            /None of this account's personas/,
        );
    });
});

describe('MCP: writing, and what it was made with', function () {
    this.timeout(120000);

    // Ada writes through her agent, and by hand; Bea is somebody else, on the same node.
    let ada, adaRoot, adaKey, agent, bea, beaRoot, beaPost, beaClosed;

    // The tags a post wears in public: the author's own statements about it.
    const postTags = async (root, doc) => {
        const post = await (await makeFetch()(`api/id/${root}/posts/${doc}`)).json();
        return post.annotations
            .filter((a) => a.key === 'tag' && a.annotator === root)
            .map((a) => a.value)
            .sort();
    };
    const draftTags = async (doc) =>
        (await (await ada(`api/identity/${adaRoot}/docs/${doc}/annotations`)).json()).tags.sort();
    const headOf = async (doc) =>
        (await (await ada(`api/identity/${adaRoot}/docs/${doc}`)).json()).heads[0].version;
    const docCount = async () =>
        (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs.length;

    before(async () => {
        ({ me: ada, root: adaRoot, key: adaKey, agent } = await keyed('mcpwriter'));
        bea = await makeUserFetch({ prefix: 'mcpbea' });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        const post = async (body, wishes) => {
            const d = await (
                await j(bea, `api/identity/${beaRoot}/docs`, { title: '', body, format: 'marquee' })
            ).json();
            const p = await j(bea, `api/identity/${beaRoot}/docs/${d.doc_id}/publish`, wishes);
            assert.equal(p.status, 200, await p.clone().text());
            return (await p.json()).post_id;
        };
        beaPost = await post('hay is for horses', {});
        beaClosed = await post('no replies, please', { settled: true });
    });

    it('lists the writers, everything said in public marked destructive', async () => {
        const { tools } = await request(agent, 'tools/list');
        const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
        for (const name of ['publish', 'reply', 'unpublish', 'delete_document', 'label']) {
            assert.equal(hints[name].destructiveHint, true, `${name} asks first`);
        }
        assert.equal(hints.write_document.destructiveHint, false, 'a note is private');
        for (const name of ['follow', 'trust']) {
            assert.equal(hints[name].idempotentHint, true, name);
            assert.equal(hints[name].destructiveHint, false, name);
        }
    });

    it('a post through the agent says "ai-agent", and the feed can leave it out', async () => {
        const made = await tool(agent, 'publish', { words: 'four legs, one mane', title: 'horse' });
        assert.ok(!made.stopped, made.stopped);
        const [root, doc] = made.post.split('/');
        assert.equal(root, adaRoot);
        assert.deepEqual(
            (await postTags(root, doc)).filter((t) => t !== 'micro'),
            ['ai-agent'],
        );

        let seen = false;
        for (let i = 0; i < 30 && !seen; i++) {
            seen = (await tool(agent, 'read_feed', { limit: 50 })).posts.some(
                (p) => p.post === made.post,
            );
            if (!seen) await wait(300);
        }
        assert.ok(seen, 'in the feed');
        const hidden = await tool(agent, 'read_feed', { limit: 50, hide_agents: true });
        assert.ok(!hidden.posts.some((p) => p.post === made.post), 'and out of it, when asked');
    });

    it('a key without the agent says "api-key"; a browser says nothing', async () => {
        const script = program(adaKey);
        const d = await (
            await j(script, `api/identity/${adaRoot}/docs`, {
                title: 's',
                body: 'a script',
                format: 'marquee',
            })
        ).json();
        const p = await (
            await j(script, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {})
        ).json();
        assert.deepEqual(
            (await postTags(adaRoot, p.post_id)).filter((t) => t !== 'micro'),
            ['api-key'],
        );

        const h = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title: 'h',
                body: 'by hand',
                format: 'marquee',
            })
        ).json();
        const hp = await (
            await j(ada, `api/identity/${adaRoot}/docs/${h.doc_id}/publish`, {})
        ).json();
        assert.deepEqual(
            (await postTags(adaRoot, hp.post_id)).filter((t) => t !== 'micro'),
            [],
        );
    });

    it('sticks through an edit by hand; only a person takes it off; the next keyed write puts it back', async () => {
        const made = await tool(agent, 'publish', { words: 'drafted by the agent' });
        const doc = made.document;
        const [, post] = made.post.split('/');
        const tags = async () => (await postTags(adaRoot, post)).filter((t) => t !== 'micro');

        // A person edits the words and posts again: the label stays (ruling 6).
        const saved = await j(
            ada,
            `api/identity/${adaRoot}/docs/${doc}`,
            { title: '', body: 'fixed by hand', parents: [await headOf(doc)], format: 'marquee' },
            'PUT',
        );
        assert.equal(saved.status, 200, await saved.clone().text());
        await j(ada, `api/identity/${adaRoot}/docs/${doc}/publish`, {});
        assert.deepEqual(await tags(), ['ai-agent'], 'an edit by hand keeps it');

        // A key may take it off neither the draft nor the post.
        const script = program(adaKey);
        const off = await script(`api/identity/${adaRoot}/docs/${doc}/annotations/tags/ai-agent`, {
            method: 'DELETE',
        });
        assert.equal(off.status, 403, await off.text());
        const retract = await script(
            `api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}/tag/ai-agent`,
            { method: 'DELETE' },
        );
        assert.equal(retract.status, 403, await retract.text());
        assert.deepEqual(await draftTags(doc), ['ai-agent']);

        // The person can: the next post says so.
        const vouched = await ada(`api/identity/${adaRoot}/docs/${doc}/annotations/tags/ai-agent`, {
            method: 'DELETE',
        });
        assert.equal(vouched.status, 200);
        await j(ada, `api/identity/${adaRoot}/docs/${doc}/publish`, {});
        assert.deepEqual(await tags(), [], 'vouched for');

        // And new work by the agent brings it back.
        assert.ok(
            !(await tool(agent, 'write_document', { document: doc, words: 'the agent again' }))
                .stopped,
        );
        await tool(agent, 'publish', { document: doc });
        assert.deepEqual(await tags(), ['ai-agent'], 'the next keyed write');
    });

    it('notes: written, rewritten, posted, posted again as an update, deleted', async () => {
        const made = await tool(agent, 'write_document', {
            title: 'stable',
            words: 'hay: 2 bales',
        });
        const doc = made.document;
        await tool(agent, 'write_document', { document: doc, words: 'hay: 3 bales' });
        const read = await tool(agent, 'read_document', { document: doc });
        assert.equal(read.title, 'stable', 'the title kept');
        assert.equal(read.words.text, 'hay: 3 bales');

        const first = await tool(agent, 'publish', { document: doc });
        const again = await tool(agent, 'publish', { document: doc });
        assert.equal(again.post, first.post, 'posting a note again updates its post');

        const gone = await tool(agent, 'delete_document', { document: doc });
        assert.equal(gone.deleted, doc);
        assert.match((await tool(agent, 'publish', {})).stopped, /document.*words/);
    });

    it("replies to somebody else's post, and not where they asked for none", async () => {
        const replied = await tool(agent, 'reply', {
            post: `${beaRoot}/${beaPost}`,
            words: 'neigh, agreed',
        });
        assert.ok(!replied.stopped, replied.stopped);
        // The reply itself. Whether Bea's thread shows it is Bea's to say: a stranger's reply waits
        // for the author's nod (comments.cjs, slice 6), and Ada is a stranger to her.
        const reply = await tool(agent, 'read_post', { post: replied.post });
        assert.equal(reply.post.reply_to, `${beaRoot}/${beaPost}`, 'it answers her post');
        assert.equal(reply.post.words.text, 'neigh, agreed');
        const [, replyDoc] = replied.post.split('/');
        assert.ok((await postTags(adaRoot, replyDoc)).includes('ai-agent'), 'a reply says it too');

        const closed = await tool(agent, 'read_post', { post: `${beaRoot}/${beaClosed}` });
        assert.ok(closed.post, JSON.stringify(closed));
        assert.ok(closed.post.closed, 'the card says replies are closed');
        const before = await docCount();
        assert.ok(
            (await tool(agent, 'reply', { post: `${beaRoot}/${beaClosed}`, words: 'hi' })).stopped,
        );
        assert.equal(await docCount(), before, 'and a refused reply leaves no draft behind');
    });

    it("labels somebody else's post and takes it back; its own post's tags are its note's", async () => {
        const on = await tool(agent, 'label', { post: `${beaRoot}/${beaPost}`, tag: '🐴' });
        assert.equal(on.labelled, '🐴');
        const said = async () =>
            await (
                await ada(`api/identity/${adaRoot}/public-annotations/${beaRoot}/${beaPost}`)
            ).json();
        assert.ok(JSON.stringify(await said()).includes('🐴'), JSON.stringify(await said()));
        await tool(agent, 'label', { post: `${beaRoot}/${beaPost}`, tag: '🐴', remove: true });
        assert.ok(!JSON.stringify(await said()).includes('🐴'), 'taken back');

        const mine = await tool(agent, 'publish', { words: 'mine' });
        assert.match(
            (await tool(agent, 'label', { post: mine.post, tag: 'x' })).stopped,
            /own post/,
        );
    });

    it("follows and trusts: the dials on the persona's private chain", async () => {
        assert.equal(
            (await tool(agent, 'follow', { who: beaRoot, level: 'high' })).interest,
            'high',
        );
        assert.equal(
            (await tool(agent, 'trust', { who: beaRoot, level: 'medium' })).trust,
            'medium',
        );
        const facts = await (
            await ada(
                `api/identity/${adaRoot}/private/kv/${encodeURIComponent(`contact:${beaRoot}`)}`,
            )
        ).json();
        const value = (k) => facts.values.find((v) => v.key === k)?.value;
        assert.equal(value('interest'), 'high');
        assert.equal(value('trust'), 'medium');
        assert.match(
            (await tool(agent, 'trust', { who: beaRoot, level: 'lots' })).stopped,
            /level/,
        );
        assert.match(
            (await tool(agent, 'follow', { who: adaRoot, level: 'max' })).stopped,
            /itself/,
        );
    });

    it("takes its own post down, and nobody else's", async () => {
        const mine = await tool(agent, 'publish', { words: 'short-lived' });
        assert.equal((await tool(agent, 'unpublish', { post: mine.post })).unpublished, mine.post);
        assert.match(
            (await tool(agent, 'unpublish', { post: `${beaRoot}/${beaPost}` })).stopped,
            /isn't this persona's/,
        );
    });
});

describe('MCP: chat, the Bank and the Market', function () {
    this.timeout(120000);

    let me, root, key, agent, room;

    before(async () => {
        ({ me, root, key, agent } = await keyed('mcpplayer'));
        // A room of her own, made as the app makes one: a note in the chat bucket, posted as a room.
        const d = await (
            await j(me, `api/identity/${root}/docs`, {
                title: 'the barn',
                body: 'hay talk',
                format: 'marquee',
            })
        ).json();
        await me(`api/identity/${root}/docs/${d.doc_id}/buckets/chat`, { method: 'PUT' });
        const p = await j(me, `api/identity/${root}/docs/${d.doc_id}/publish`, { room: true });
        assert.equal(p.status, 200, await p.clone().text());
        room = `${root}/${(await p.json()).post_id}`;
        // Something to spend: the rig writes the ledger directly (bank.cjs).
        await j(makeFetch(), 'test/credit', { root, pennies: 1000000 });
    });

    it('lists its tools: reading looks, saying in a room asks first, money never does', async () => {
        const { tools } = await request(agent, 'tools/list');
        const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
        for (const name of ['list_rooms', 'read_room', 'bank', 'market']) {
            assert.equal(hints[name].readOnlyHint, true, `${name} only looks`);
        }
        assert.equal(hints.send_message.destructiveHint, true, 'said in a room, in her name');
        for (const name of ['buy', 'sell']) {
            assert.equal(hints[name].destructiveHint, false, `${name}: HorseBucks are imaginary`);
        }
    });

    it('lists the room, says something in it, and reads it back, fenced', async () => {
        const rooms = await tool(agent, 'list_rooms');
        assert.ok(
            rooms.rooms.some((r) => r.room === room),
            JSON.stringify(rooms),
        );

        const said = await tool(agent, 'send_message', { room, words: 'neigh, from the agent' });
        assert.ok(!said.stopped, said.stopped);
        const read = await tool(agent, 'read_room', { room, limit: 5 });
        assert.equal(read.title.text, 'the barn');
        const line = read.lines.find((l) => l.words.text === 'neigh, from the agent');
        assert.ok(line, JSON.stringify(read.lines));
        assert.equal(line.speaker.root, root);
        assert.match(line.said, /^\d{4}-\d\d-\d\dT/);
        assert.match((await tool(agent, 'read_room', { room: 'nowhere' })).stopped, /address/);
        assert.match((await tool(agent, 'send_message', { room, words: '  ' })).stopped, /nothing/);
    });

    it('a line says what it was made with, and an edit never takes it away', async () => {
        const [, doc] = room.split('/');
        const door = `api/identity/${root}/rooms/${root}/${doc}/messages`;
        const say = (as, body) => j(as, door, body);
        await say(me, { words: 'typed by hand' });
        await say(program(key), { words: 'from a script' });
        await tool(agent, 'send_message', { room, words: 'from the agent' });
        const lines = async () => (await (await me(door)).json()).items;
        const by = (all, words) => all.find((l) => l.words === words);

        let all = await lines();
        assert.equal(by(all, 'typed by hand').made_with, undefined, 'a person: nothing');
        assert.equal(by(all, 'from a script').made_with, 'api-key');
        assert.equal(by(all, 'from the agent').made_with, 'ai-agent');
        const read = await tool(agent, 'read_room', { room });
        assert.equal(
            read.lines.find((l) => l.words.text === 'from the agent').made_with,
            'ai-agent',
        );

        // A person's edit of the agent's line keeps the mark; a script's edit of a person's adds one.
        await say(me, { words: 'the agent, fixed by hand', edits: by(all, 'from the agent').hash });
        await say(program(key), {
            words: 'by hand, tidied by a script',
            edits: by(all, 'typed by hand').hash,
        });
        all = await lines();
        assert.equal(by(all, 'the agent, fixed by hand').made_with, 'ai-agent', 'sticks');
        assert.equal(
            by(all, 'by hand, tidied by a script').made_with,
            'api-key',
            'marked by its edit',
        );
    });

    it('the Bank: the balance in HorseBucks, and what it was earned from', async () => {
        const bank = await tool(agent, 'bank');
        assert.match(bank.balance, /^H\$ -?[\d,]+\.\d\d$/);
        assert.ok(Array.isArray(bank.open_contracts) && Array.isArray(bank.recent));
    });

    it("the Market's prices, and buying and selling hay, a lot at a time", async () => {
        const market = await tool(agent, 'market');
        const hay = market.commodities.find((c) => c.commodity === 'hay');
        assert.match(hay.price_today, /^H\$ [\d,]+\.\d\d$/);

        const bought = await tool(agent, 'buy', { commodity: 'hay', units: '2' });
        assert.ok(bought.lot, JSON.stringify(bought));
        const lot = (await tool(agent, 'bank')).commodity_lots.find((l) => l.lot === bought.lot);
        assert.equal(lot.units, '2');
        assert.equal(lot.sellable, false, 'held two days first');
        assert.match((await tool(agent, 'sell', { lot: bought.lot })).stopped, /two days/);

        await j(makeFetch(), 'test/age-lot', { root, lot: bought.lot, days: 3 });
        const sold = await tool(agent, 'sell', { lot: bought.lot });
        assert.ok(!sold.stopped, sold.stopped);
        assert.ok(
            !(await tool(agent, 'bank')).commodity_lots.some((l) => l.lot === bought.lot),
            'sold whole: no longer held',
        );
    });

    it('a hrseBond for an amount, and the door keeps its own rules', async () => {
        const bought = await tool(agent, 'buy', { bond: '2,000' });
        assert.match(bought.bought, /H\$ 2,000\.00/);
        const bond = (await tool(agent, 'bank')).bonds[0];
        assert.equal(bond.price, 'H$ 2,000.00');
        assert.match((await tool(agent, 'sell', { bond: bond.bond })).stopped, /debt/);
        assert.match((await tool(agent, 'buy', { bond: '5' })).stopped, /at least/);
        assert.match((await tool(agent, 'buy', { bond: 'lots' })).stopped, /isn't an amount/);
        assert.match((await tool(agent, 'buy', { unlock: 'unicorns' })).stopped, /no unlock/);
        assert.match((await tool(agent, 'buy', {})).stopped, /one thing at a time/);
    });
});

/*
    The first cut's gaps (plans/MCP.md, Slice 7; Curtis, 2026-10-07: "Let's build 1-7 and 9"), from
    an agent's own review of using the connector: a document list that pages and searches, a
    note's tags, pins, shares, who follows and trusts whom, the name and bio, notifications a page
    at a time and marked up to a point, the colourway, and a file's picture.
*/
describe('MCP: the gaps an agent found', function () {
    this.timeout(180000);

    let me, root, agent, pal, palRoot, palPost;

    before(async () => {
        ({ me, root, agent } = await keyed('mcpgaps'));
        pal = await makeUserFetch({ prefix: 'mcpgapspal' });
        palRoot = (await (await pal('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(pal, `api/identity/${palRoot}/profile`, { field: 'name', value: 'Pal' });
        const draft = await (
            await j(pal, `api/identity/${palRoot}/docs`, {
                title: 'a shareable thing',
                body: 'worth passing on',
                format: 'marquee',
            })
        ).json();
        const published = await j(pal, `api/identity/${palRoot}/docs/${draft.doc_id}/publish`, {});
        palPost = `${palRoot}/${(await published.json()).post_id}`;
    });

    it('list_documents: pages, counts, searches titles, and keeps to the published', async () => {
        for (let i = 1; i <= 5; i++) {
            await j(me, `api/identity/${root}/docs`, {
                title: `haybale ${i}`,
                body: 'words',
                format: 'marquee',
            });
        }
        const other = await (
            await j(me, `api/identity/${root}/docs`, {
                title: 'oats',
                body: 'w',
                format: 'marquee',
            })
        ).json();
        await j(me, `api/identity/${root}/docs/${other.doc_id}/publish`, {});

        const counted = await tool(agent, 'list_documents', {
            search: 'HAYBALE',
            count_only: true,
        });
        assert.deepEqual([counted.count, counted.documents], [5, undefined], 'a count, no list');
        const first = await tool(agent, 'list_documents', { search: 'haybale', limit: 2 });
        assert.equal(first.documents.length, 2);
        assert.equal(first.count, 5);
        assert.ok(first.next, 'more to read');
        const second = await tool(agent, 'list_documents', {
            search: 'haybale',
            limit: 2,
            next: first.next,
        });
        const third = await tool(agent, 'list_documents', {
            search: 'haybale',
            limit: 2,
            next: second.next,
        });
        assert.equal(third.next, undefined, 'the last page says so');
        const ids = [...first.documents, ...second.documents, ...third.documents].map(
            (d) => d.document,
        );
        assert.equal(new Set(ids).size, 5, 'every one once');
        const published = await tool(agent, 'list_documents', { published: true });
        assert.ok(published.documents.every((d) => d.published));
        assert.ok(published.documents.some((d) => d.document === other.doc_id));
        assert.match(
            (await tool(agent, 'list_documents', { next: 'pony' })).stopped,
            /isn't one list_documents gave/,
        );
    });

    it("write_document: sets a note's tags as a whole set, with or without new words", async () => {
        const tagsOf = async (doc) =>
            (await (await me(`api/identity/${root}/docs/${doc}/annotations`)).json()).tags.sort();
        const made = await tool(agent, 'write_document', {
            title: 'tagged by an agent',
            words: 'some words',
            tags: ['oats', 'hay'],
        });
        assert.ok(!made.stopped, made.stopped);
        // What it was made with stays, whatever set is asked for (ruling 6).
        assert.deepEqual(made.tags, ['ai-agent', 'hay', 'oats']);
        assert.deepEqual(await tagsOf(made.document), ['ai-agent', 'hay', 'oats']);
        const heads = async () =>
            (await (await me(`api/identity/${root}/docs/${made.document}`)).json()).heads[0]
                .version;
        const before = await heads();
        const retagged = await tool(agent, 'write_document', {
            document: made.document,
            tags: ['hay', 'carrots'],
        });
        assert.deepEqual(retagged.tags, ['ai-agent', 'carrots', 'hay']);
        assert.deepEqual(
            await tagsOf(made.document),
            ['ai-agent', 'carrots', 'hay'],
            'oats off, carrots on',
        );
        // A tag with a space, and one with a plus, arrive as written (2026-10-08: "indie web" landed
        // as "indie+web" - the path was form-encoded).
        const spaced = await tool(agent, 'write_document', {
            document: made.document,
            tags: ['indie web', 'c++'],
        });
        assert.deepEqual(spaced.tags, ['ai-agent', 'c++', 'indie web']);
        assert.deepEqual(await tagsOf(made.document), ['ai-agent', 'c++', 'indie web']);
        const bare = await tool(agent, 'write_document', { document: made.document, tags: [] });
        assert.deepEqual(bare.tags, ['ai-agent'], '[] clears all but what it was made with');
        assert.equal(await heads(), before, 'tags alone write no new version');
        assert.match(
            (await tool(agent, 'write_document', { document: made.document })).stopped,
            /words, its tags, or both/,
        );
    });

    it('pin_document: pins and unpins, and the list says so', async () => {
        const made = await tool(agent, 'write_document', { title: 'to pin', words: 'pin me' });
        const pinnedNow = async () =>
            (await tool(agent, 'list_documents', { search: 'to pin' })).documents.find(
                (d) => d.document === made.document,
            ).pinned;
        assert.deepEqual(await tool(agent, 'pin_document', { document: made.document }), {
            document: made.document,
            pinned: true,
        });
        assert.equal(await pinnedNow(), true);
        await tool(agent, 'pin_document', { document: made.document, unpin: true });
        assert.ok(!(await pinnedNow()), 'and off again');
    });

    it("share: somebody else's post, and back; never one's own", async () => {
        const shares = async () =>
            (await (await me(`api/identity/${root}/rebroadcasts`)).json()).items.map(
                (r) => `${r.author}/${r.doc_id}`,
            );
        const shared = await tool(agent, 'share', { post: palPost });
        assert.deepEqual(shared, { post: palPost, shared: true });
        assert.ok((await shares()).includes(palPost), 'on the chain');
        await tool(agent, 'share', { post: palPost, unshare: true });
        assert.ok(!(await shares()).includes(palPost), 'taken back');
        const mine = await tool(agent, 'write_document', { title: 'mine', words: 'w' });
        const posted = await j(me, `api/identity/${root}/docs/${mine.document}/publish`, {});
        const own = `${root}/${(await posted.json()).post_id}`;
        assert.match((await tool(agent, 'share', { post: own })).stopped, /own post/);
    });

    it('list_contacts and list_followers: who it follows and trusts, and who follows it', async () => {
        await tool(agent, 'follow', { who: palRoot, level: 'high' });
        await tool(agent, 'trust', { who: palRoot, level: 'max' });
        const contacts = await tool(agent, 'list_contacts');
        const palRow = contacts.people.find((p) => p.root === palRoot);
        assert.ok(palRow, 'Pal is a contact');
        assert.deepEqual([palRow.interest, palRow.trust], ['high', 'max']);
        assert.deepEqual(palRow.name, { author: 'Pal', text: 'Pal' }, 'a name is fenced');
        assert.ok(
            (await tool(agent, 'list_contacts', { only: 'trusted' })).people.some(
                (p) => p.root === palRoot,
            ),
        );
        assert.match(
            (await tool(agent, 'list_contacts', { only: 'enemies' })).stopped,
            /following or trusted/,
        );

        // Pal follows back, publicly; the edge reaches this node's graph on its own beat.
        await j(
            pal,
            `api/identity/${palRoot}/private/kv/${encodeURIComponent(`contact:${root}`)}/interest`,
            { value: 'high' },
            'PUT',
        );
        let follower;
        for (let i = 0; i < 60 && !follower; i++) {
            const followers = await tool(agent, 'list_followers');
            assert.ok(!followers.stopped, followers.stopped);
            follower = followers.people.find((p) => p.root === palRoot);
            if (!follower) await wait(500);
        }
        assert.ok(follower, 'Pal follows, as far as this node knows');
        assert.equal(follower.interest, 'high');
    });

    it('edit_profile: the name and the bio; never an empty name', async () => {
        const edited = await tool(agent, 'edit_profile', {
            name: '  Gap Filler  ',
            bio: 'I fill gaps.',
        });
        assert.deepEqual(edited.changed, { name: 'Gap Filler', bio: 'I fill gaps.' });
        const profile = await (await me(`api/identity/${root}/profile`)).json();
        const field = (f) => (profile.find((p) => p.field === f) || {}).value;
        assert.deepEqual([field('name'), field('bio')], ['Gap Filler', 'I fill gaps.']);
        assert.match((await tool(agent, 'edit_profile', { name: ' ' })).stopped, /can't be empty/);
        assert.match((await tool(agent, 'edit_profile', {})).stopped, /name, a new bio/);
    });

    it('read_notifications pages; mark_notifications_seen stops where it is told', async () => {
        // Two notifications for this persona: Pal's follow (above) and Pal's label on its post.
        const mine = await tool(agent, 'write_document', { title: 'label me', words: 'w' });
        const posted = await j(me, `api/identity/${root}/docs/${mine.document}/publish`, {});
        const postId = (await posted.json()).post_id;
        await j(
            pal,
            `api/identity/${palRoot}/public-annotations/${root}/${postId}`,
            { key: 'tag', value: 'lovely' },
            'PUT',
        );
        let all;
        for (let i = 0; i < 60; i++) {
            all = await tool(agent, 'read_notifications', { limit: 100 });
            if (all.notifications.length >= 2) break;
            await wait(500);
        }
        assert.ok(all.notifications.length >= 2, JSON.stringify(all));
        const page = await tool(agent, 'read_notifications', { limit: 1 });
        assert.equal(page.notifications.length, 1);
        assert.ok(page.next, 'more behind it');
        const rest = await tool(agent, 'read_notifications', { limit: 100, next: page.next });
        assert.ok(rest.notifications.length >= 1);
        // Through the older one: it and everything before it, never the newer.
        const [newer, older] = all.notifications;
        assert.notEqual(newer.mark, older.mark, 'two moments');
        await tool(agent, 'mark_notifications_seen', { through: older.mark });
        const after = await tool(agent, 'read_notifications', { limit: 100 });
        const seen = (mark) => after.notifications.find((n) => n.mark === mark).seen;
        assert.equal(seen(older.mark), true);
        assert.equal(seen(newer.mark), false, 'the newer stays unseen');
    });

    it('set_colorway: a free one, and never a name that is none', async () => {
        assert.deepEqual(await tool(agent, 'set_colorway', { colorway: 'Witchlight' }), {
            persona: root,
            colorway: 'witchlight',
        });
        const profile = await (await me(`api/identity/${root}/profile`)).json();
        assert.equal(profile.find((p) => p.field === 'colorway').value, 'witchlight');
        assert.match(
            (await tool(agent, 'set_colorway', { colorway: 'plaid' })).stopped,
            /isn't a colourway/,
        );
    });

    it("read_document: a file's picture, as a PNG", async () => {
        const queued = await (
            await me(`api/identity/${root}/docs/binary?title=penpen`, {
                method: 'POST',
                body: makePng(64, 48),
                file: true,
            })
        ).json();
        for (let i = 0; i < 200; i++) {
            const jobs = await (await me(`api/identity/${root}/ingest`)).json();
            const job = jobs.find((x) => x.job_id === queued.job_id);
            if (job && job.status === 'done') break;
            await wait(150);
        }
        const result = await callTool(agent, 'read_document', { document: queued.doc_id });
        assert.ok(!result.isError, result.content[0].text);
        const said = JSON.parse(result.content[0].text);
        assert.equal(said.kind, 'file');
        const picture = result.content[1];
        assert.equal(picture.type, 'image');
        assert.equal(picture.mimeType, 'image/png');
        const png = Buffer.from(picture.data, 'base64');
        assert.ok(
            png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
            'a PNG',
        );
    });
});

describe('MCP: connecting an assistant with OAuth', function () {
    this.timeout(120000);

    const http = require('node:http');
    const crypto = require('node:crypto');
    const { HOST } = require('./fetch.cjs');
    const base = `http://${HOST}`;
    const REDIRECT = 'http://127.0.0.1:33418/callback';

    let me, docServer, docUrl;

    // PKCE (RFC 7636): a verifier, and its S256 challenge.
    const pkce = () => {
        const verifier = crypto.randomBytes(48).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        return { verifier, challenge };
    };
    // The consent page's answer, as the signed-in browser sends it.
    const consent = async (client_id, challenge, approve = true, redirect_uri = REDIRECT) => {
        const r = await j(me, 'api/oauth/consent', {
            response_type: 'code',
            client_id,
            redirect_uri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'xyz',
            approve,
        });
        assert.equal(r.status, 200, await r.clone().text());
        return new URL((await r.json()).redirect);
    };
    // Form-encoded, as RFC 6749 asks - `file` tells the helper not to call the body JSON (fetch.cjs).
    const token = (fields) =>
        makeFetch()('oauth/token', {
            method: 'POST',
            file: true,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', ...fields }).toString(),
        });
    const register = async (body) => {
        const r = await makeFetch()('oauth/register', {
            method: 'POST',
            body: JSON.stringify(body),
        });
        return { status: r.status, body: await r.json() };
    };

    before(async () => {
        me = await makeUserFetch({ prefix: 'mcpoauth' });
        await me('api/identity', { method: 'POST' });
        // A client known by its metadata document: served here, on the rig's loopback.
        docServer = http.createServer((req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(
                JSON.stringify({
                    client_id: docUrl,
                    client_name: 'Doc Assistant',
                    redirect_uris: [REDIRECT],
                }),
            );
        });
        await new Promise((resolve) => docServer.listen(0, '127.0.0.1', resolve));
        docUrl = `http://127.0.0.1:${docServer.address().port}/client.json`;
    });
    after(() => docServer && docServer.close());

    it('a 401 from /mcp points at the metadata, which points at this node', async () => {
        const r = await initialize(makeFetch());
        assert.equal(r.status, 401);
        const challenge = r.headers.get('www-authenticate');
        assert.match(challenge, /^Bearer resource_metadata="(.+)"$/);
        const resourceUrl = challenge.match(/"(.+)"/)[1];
        assert.equal(resourceUrl, `${base}/.well-known/oauth-protected-resource/mcp`);

        const resource = await (
            await makeFetch()('.well-known/oauth-protected-resource/mcp')
        ).json();
        assert.equal(resource.resource, `${base}/mcp`);
        assert.deepEqual(resource.authorization_servers, [base]);
        const server = await (await makeFetch()('.well-known/oauth-authorization-server')).json();
        assert.equal(server.issuer, base);
        assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
        assert.equal(server.client_id_metadata_document_supported, true);
        assert.equal(server.token_endpoint, `${base}/oauth/token`);
    });

    it('registers, consents, trades the code for a key that works and is listed with the rest', async () => {
        const reg = await register({ client_name: 'Test Assistant', redirect_uris: [REDIRECT] });
        assert.equal(reg.status, 201, JSON.stringify(reg.body));
        const client_id = reg.body.client_id;
        assert.match(client_id, /^rtc_/);

        const { verifier, challenge } = pkce();
        const back = await consent(client_id, challenge);
        assert.equal(back.searchParams.get('state'), 'xyz');
        assert.equal(back.searchParams.get('iss'), base);
        const code = back.searchParams.get('code');
        assert.ok(code);

        const wrong = await token({
            code,
            redirect_uri: REDIRECT,
            client_id,
            code_verifier: `${verifier}x`,
        });
        assert.equal(wrong.status, 400);
        assert.equal((await wrong.json()).error, 'invalid_grant');

        // That try spent the code: a fresh one, with the right verifier.
        const again = pkce();
        const fresh = (await consent(client_id, again.challenge)).searchParams.get('code');
        const traded = await token({
            code: fresh,
            redirect_uri: REDIRECT,
            client_id,
            code_verifier: again.verifier,
        });
        assert.equal(traded.status, 200, await traded.clone().text());
        assert.equal(traded.headers.get('cache-control'), 'no-store');
        const { access_token, token_type } = await traded.json();
        assert.match(access_token, /^rtk_[0-9a-f]{64}$/);
        assert.equal(token_type, 'Bearer');

        const reused = await token({
            code: fresh,
            redirect_uri: REDIRECT,
            client_id,
            code_verifier: again.verifier,
        });
        assert.equal((await reused.json()).error, 'invalid_grant', 'a code works once');

        assert.equal((await initialize(program(access_token))).status, 200, 'the key opens /mcp');
        const keys = (await (await me('api/auth/keys')).json()).keys;
        assert.ok(
            keys.some((k) => k.name === 'Test Assistant (assistant)'),
            JSON.stringify(keys),
        );
    });

    it('a client known by its metadata document connects without registering', async () => {
        const { verifier, challenge } = pkce();
        const asked = await me(
            `api/oauth/request?${new URLSearchParams({
                response_type: 'code',
                client_id: docUrl,
                redirect_uri: REDIRECT,
                code_challenge: challenge,
                code_challenge_method: 'S256',
            })}`,
        );
        assert.equal(asked.status, 200, await asked.clone().text());
        assert.equal((await asked.json()).client.name, 'Doc Assistant');
        const code = (await consent(docUrl, challenge)).searchParams.get('code');
        const traded = await token({
            code,
            redirect_uri: REDIRECT,
            client_id: docUrl,
            code_verifier: verifier,
        });
        assert.equal(traded.status, 200, await traded.clone().text());
    });

    it('refuses: no, a redirect never registered, a key at the consent door, a registration that runs', async () => {
        const reg = await register({ client_name: 'Picky', redirect_uris: [REDIRECT] });
        const client_id = reg.body.client_id;
        const { challenge } = pkce();

        const no = await consent(client_id, challenge, false);
        assert.equal(no.searchParams.get('error'), 'access_denied');
        assert.equal(no.searchParams.get('code'), null);

        const elsewhere = await j(me, 'api/oauth/consent', {
            response_type: 'code',
            client_id,
            redirect_uri: 'https://evil.example/cb',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            approve: true,
        });
        assert.equal(elsewhere.status, 400);
        assert.match((await elsewhere.json()).message, /redirect URI/);

        const made = await j(me, 'api/auth/keys', { name: 'a script' });
        const key = (await made.json()).key;
        const byKey = await program(key)('api/oauth/consent', {
            method: 'POST',
            body: JSON.stringify({
                response_type: 'code',
                client_id,
                redirect_uri: REDIRECT,
                code_challenge: challenge,
                code_challenge_method: 'S256',
                approve: true,
            }),
        });
        assert.equal(byKey.status, 403, 'keys are made from a browser');

        assert.equal((await register({ redirect_uris: ['javascript:alert(1)'] })).status, 400);
        assert.equal((await register({ redirect_uris: ['http://example.com/cb'] })).status, 400);
    });
});
