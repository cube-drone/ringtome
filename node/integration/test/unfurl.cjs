/*
    The turbolink unfurl endpoint (net::unfurl): the node fetches foreign pages' OpenGraph
    cards on the browser's behalf. What integration can prove WITHOUT touching the real
    internet is exactly the safety envelope: the session gate, the SSRF guard (loopback and
    private names refused - which we can exercise with real DNS against real local
    addresses), and the global rate limit (refusals spend the same budget, so the 429 is
    reachable offline). The happy-path parse is pinned by Rust unit tests on fixtures.

    A stranger may ask too (2026-10-08), about a link a public post on this node points to,
    named by `in` and checked against that post's public words - and nothing else. A private
    address in the post is how that is proven offline: past the gate, the SSRF guard refuses it
    with a 400, which a stranger stopped AT the gate never sees.
*/
const assert = require('node:assert');
const { HOST, makeFetch } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
// A private address: the guard refuses it after the gate, with no internet needed.
const LINK = 'http://192.168.7.7/the-story';

describe('unfurl', () => {
    let user, root, open, sealed;
    const stranger = makeFetch();
    const ask = (url, place) =>
        stranger(
            `api/unfurl?url=${encodeURIComponent(url)}${place ? `&in=${encodeURIComponent(place)}` : ''}`,
        );

    before(async function () {
        this.timeout(120000);
        user = await makeUserFetch({ prefix: 'unfurl' });
        root = (await (await user('api/identity', { method: 'POST' })).json()).root_pubkey;
        const publish = async (extra = {}) => {
            const d = await (
                await j(user, `api/identity/${root}/docs`, {
                    title: 'read this',
                    body: `the paper says [so](${LINK}) - see for yourself`,
                    format: 'marquee',
                })
            ).json();
            const pub = await j(user, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
            assert.equal(pub.status, 200, await pub.clone().text());
            return (await pub.json()).post_id;
        };
        open = await publish();
        sealed = await publish({ trusted_only: true });
        // Until a stranger can read the post's words through its public door.
        for (let i = 0; i < 30; i++) {
            const body = await stranger(`id/${root}/docs/${open}/body`);
            if (body.status === 200) break;
            await beat(HOST, 'fold', root);
            await wait(300);
        }
    });

    it('asks a stranger for a session, or the public post the link is in', async () => {
        const anon = makeFetch();
        const resp = await anon(`api/unfurl?url=${encodeURIComponent('https://example.com/')}`);
        assert.equal(resp.status, 401);
    });

    it('lets a stranger ask about a link a public post here points to', async () => {
        const resp = await ask(LINK, `${root}/${open}`);
        assert.equal(resp.status, 400, 'past the gate, the address guard answers');
        assert.match((await resp.json()).message, /not public|does not resolve/i);
    });

    it('refuses a stranger a link the named post does not hold', async () => {
        assert.equal((await ask('http://192.168.7.8/another', `${root}/${open}`)).status, 403);
    });

    it("refuses a stranger a sealed post's links - its words are not the stranger's", async () => {
        assert.equal((await ask(LINK, `${root}/${sealed}`)).status, 403);
    });

    it('refuses a stranger a post that is not here, or not a post at all', async () => {
        assert.equal((await ask(LINK, `${root}/${'00'.repeat(16)}`)).status, 403);
        assert.equal((await ask(LINK, 'nonsense')).status, 403);
    });

    it('refuses non-web schemes', async () => {
        const resp = await user(`api/unfurl?url=${encodeURIComponent('file:///etc/passwd')}`);
        assert.equal(resp.status, 400);
    });

    it('refuses to be a periscope into its own network', async () => {
        // Loopback by literal, loopback by name, and a private range: the SSRF guard
        // resolves and vets every one before any connection is made.
        for (const target of [
            'http://127.0.0.1:8080/',
            'http://localhost/',
            'http://192.168.1.1/',
            'http://[::1]/',
        ]) {
            const resp = await user(`api/unfurl?url=${encodeURIComponent(target)}`);
            assert.equal(resp.status, 400, `${target} must be refused`);
            const body = await resp.json();
            assert.match(body.message, /not public|does not resolve/i);
        }
    });

    it('meters the global outbound budget generously but really', async function () {
        this.timeout(30000);
        // Refused targets spend tokens too (the budget sits in front of the guard), which
        // makes the limit provable offline: hammer refusals until 429 appears.
        let limited = false;
        for (let i = 0; i < 40 && !limited; i++) {
            const resp = await user(
                `api/unfurl?url=${encodeURIComponent(`http://192.168.0.${i + 1}/`)}`,
            );
            if (resp.status === 429) limited = true;
            else assert.equal(resp.status, 400);
        }
        assert.ok(limited, 'a sustained hammer must eventually see 429');
    });
});
