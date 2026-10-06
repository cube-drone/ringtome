/*
    The Model Context Protocol at /mcp (mcp.rs, plans/MCP.md): Horse Drawing Tycoon 2 for AI
    agents. An AI client connects with an API key - never a cookie - and calls tools that are
    requests to the node's own doors, as that key. The node keeps no sessions and answers in plain
    JSON, under both lifecycles the protocol has had: the `initialize` handshake (2025-11-25 and
    before), and from 2026-07-28 none at all, every request carrying its own version.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

// What every MCP client sends with a request: it takes either answer, JSON or an event stream.
const ACCEPT = 'application/json, text/event-stream';
const HANDSHAKE_VERSION = '2025-11-25';
const STATELESS_VERSION = '2026-07-28';

describe('MCP: an AI agent, with your API key', function () {
    this.timeout(120000);

    let me, root, key;

    // One JSON-RPC message to /mcp. `as` is a fetch: the cookieless one below carries a key, the
    // signed-in browser's carries only its cookie.
    const rpc = (as, message, headers = {}) =>
        as('mcp', {
            method: 'POST',
            headers: { Accept: ACCEPT, ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', ...message }),
        });
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
    // A tool call the handshake way: after `initialize`, every request names the version agreed.
    const callTool = async (as, name, args = {}) => {
        const r = await rpc(
            as,
            { id: 3, method: 'tools/call', params: { name, arguments: args } },
            { 'MCP-Protocol-Version': HANDSHAKE_VERSION },
        );
        assert.equal(r.status, 200, await r.clone().text());
        const { result } = await r.json();
        return result;
    };

    before(async () => {
        me = await makeUserFetch({ prefix: 'mcpuser' });
        root = (await (await me('api/identity', { method: 'POST' })).json()).root_pubkey;
        const made = await j(me, 'api/auth/keys', { name: 'my agent' });
        assert.equal(made.status, 200, await made.clone().text());
        ({ key } = await made.json());
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

    it('lists its tools, marked read-only where they only look', async () => {
        const r = await rpc(
            program(key),
            { id: 2, method: 'tools/list' },
            { 'MCP-Protocol-Version': HANDSHAKE_VERSION },
        );
        assert.equal(r.status, 200, await r.clone().text());
        const { tools } = (await r.json()).result;
        const whoami = tools.find((t) => t.name === 'whoami');
        assert.ok(whoami, JSON.stringify(tools));
        assert.equal(whoami.annotations.readOnlyHint, true);
    });

    it("whoami: the key's account and its personas, through the node's own doors", async () => {
        const result = await callTool(program(key), 'whoami');
        assert.equal(result.isError, false, JSON.stringify(result));
        const who = JSON.parse(result.content[0].text);
        assert.equal(who.username, me.account.username);
        assert.deepEqual(
            who.personas.map((p) => p.root),
            [root],
        );
        assert.equal(who.personas[0].standing, 'active');
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

    it('stops at once when the key is revoked', async () => {
        const keys = (await (await me('api/auth/keys')).json()).keys;
        const mine = keys.find((k) => k.name === 'my agent');
        assert.equal((await me(`api/auth/keys/${mine.id}`, { method: 'DELETE' })).status, 200);
        assert.equal((await initialize(program(key))).status, 401);
    });
});
