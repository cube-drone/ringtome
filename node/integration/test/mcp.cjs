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

const { makeUserFetch } = require('./helpers.cjs');
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
