/*
    Custom domains, the claim and its proof (plans/CUSTOM_DOMAINS.md, slice 1). A persona claims a
    domain in its profile; the claim counts only once the domain says the persona back, in a TXT
    record at `_ringtome.<domain>`, and every node that shows the claim checks it itself. The rig's
    domains are made up, so each node is told what DNS "holds" through `/test/dns-txt` - one node's
    pretend DNS is its own, which is what lets the second describe show a node checking for itself.
    The third shows serving (slice 3): a request whose Host is a proved domain is that persona's
    website, sent as the front would send it.
*/
const assert = require('node:assert');
const dns = require('node:dns');
const http = require('node:http');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');
const { HOST, HOST_B, makeFetch, sql } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const domainFor = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}.test`;
const pretendDns = (host, name, values) => j(makeFetch(host), 'test/dns-txt', { name, values });
const shown = async (who, root) => (await (await who(`api/id/${root}/profile`)).json()).domain;
// Custom domains are for a node's administrators, for now (2026-10-18).
const makeAdmin = (who) =>
    sql(
        `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${who.account.id}', 'node_admin')`,
        HOST,
    );

describe('custom domains: a claim counts once its domain says it back', function () {
    this.timeout(60000);

    let ada, root, domain;

    before(async () => {
        ada = await makeUserFetch({ prefix: 'domada' });
        await makeAdmin(ada);
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
        domain = domainFor('ada');
    });

    it('is anyone’s to prove; serving it is the administrators’ (2026-10-20)', async () => {
        const cy = await makeUserFetch({ prefix: 'domcy' });
        const cyRoot = (await (await cy('api/identity', { method: 'POST' })).json()).root_pubkey;
        const cyDomain = domainFor('cy');
        const claim = await (
            await j(cy, `api/identity/${cyRoot}/domain`, { domain: cyDomain }, 'PUT')
        ).json();
        assert.equal(claim.may_serve, false, 'not an administrator');
        await pretendDns(HOST, claim.record_name, [claim.record_value]);
        const proved = await (
            await cy(`api/identity/${cyRoot}/domain/check`, { method: 'POST' })
        ).json();
        assert.equal(proved.state, 'verified', 'the ✓ is theirs');
        assert.equal(await shown(cy, cyRoot), cyDomain, 'and shown');
        assert.equal(proved.serving, false, 'but this node serves it for nobody else');
        const listed = await (await makeFetch(HOST)('api/node/domains')).json();
        assert.ok(!listed.domains.some((d) => d.domain === cyDomain), 'nor lists it to the front');
        assert.equal((await (await ada(`api/identity/${root}/domain`)).json()).may_serve, true);
    });

    it('a claim is a bare domain, and is refused as anything else', async () => {
        const none = await (await ada(`api/identity/${root}/domain`)).json();
        assert.equal(none.domain, null);
        assert.match(none.record_value, /^ringtome-root=\w+$/);
        for (const bad of ['https://example.com', 'example.com/blog', 'localhost', '10.0.0.1']) {
            const res = await j(ada, `api/identity/${root}/domain`, { domain: bad }, 'PUT');
            assert.equal(res.status, 400, `${bad} should be refused`);
        }
        const raw = await j(ada, `api/identity/${root}/profile`, { field: 'domain', value: 'x/y' });
        assert.equal(raw.status, 400, 'the profile door holds the same line');
    });

    it('an unproved claim is shown nowhere; the TXT record proves it', async () => {
        const claimed = await (
            await j(
                ada,
                `api/identity/${root}/domain`,
                { domain: ` ${domain.toUpperCase()} ` },
                'PUT',
            )
        ).json();
        assert.equal(claimed.domain, domain, 'kept as the bare lowercase name');
        assert.equal(claimed.state, 'unverified');
        assert.equal(claimed.record_name, `_ringtome.${domain}`);
        assert.equal(await shown(ada, root), null, 'an unproved claim is shown nowhere');

        await pretendDns(HOST, claimed.record_name, [claimed.record_value]);
        const proved = await (
            await ada(`api/identity/${root}/domain/check`, { method: 'POST' })
        ).json();
        assert.equal(proved.state, 'verified');
        assert.equal(proved.proof, 'txt');
        assert.equal(await shown(ada, root), domain);
    });

    it('a domain that names someone else lapses the claim; withdrawing it clears it', async () => {
        const mine = await (await ada(`api/identity/${root}/domain`)).json();
        const other = mine.record_value.replace(/=\w+$/, '=11111111111111111111111111111111');
        await pretendDns(HOST, mine.record_name, [other]);
        await beat(HOST, 'domain-proofs', root);
        const lapsed = await (await ada(`api/identity/${root}/domain`)).json();
        assert.equal(lapsed.state, 'lapsed');
        assert.equal(await shown(ada, root), null);

        await pretendDns(HOST, mine.record_name, [mine.record_value]);
        await beat(HOST, 'domain-proofs', root);
        assert.equal(await shown(ada, root), domain, 'said back again, shown again');

        const gone = await (
            await j(ada, `api/identity/${root}/domain`, { domain: '' }, 'PUT')
        ).json();
        assert.equal(gone.domain, null);
        assert.equal(await shown(ada, root), null);
        await pretendDns(HOST, mine.record_name, []);
    });
});

(HOST_B ? describe : describe.skip)('custom domains: every node checks for itself', function () {
    this.timeout(120000);

    it("a reader's node shows the claim only once its own lookup agrees", async function () {
        const ada = await makeUserFetch({ prefix: 'domtwoa' });
        await makeAdmin(ada);
        const root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
        const domain = domainFor('two');
        const claim = await (await j(ada, `api/identity/${root}/domain`, { domain }, 'PUT')).json();
        await pretendDns(HOST, claim.record_name, [claim.record_value]);
        await ada(`api/identity/${root}/domain/check`, { method: 'POST' });
        assert.equal(await shown(ada, root), domain, "proved on the author's node");

        const bea = await makeUserFetch({ prefix: 'domtwob', host: HOST_B });
        await bea('api/identity', { method: 'POST' });
        const { toBase58 } = await import('../../js/speakable.js');
        const via = toBase58((await (await ada('api/node')).json()).endpoint_id);
        if ((await bea(`api/id/${root}/profile?via=${via}`)).status !== 200) this.skip();
        await pullAndFold(HOST_B, root);
        await beat(HOST_B, 'domain-proofs', root);
        assert.equal(await shown(bea, root), null, "B's DNS doesn't say it: B shows nothing");

        await pretendDns(HOST_B, claim.record_name, [claim.record_value]);
        await beat(HOST_B, 'domain-proofs', root);
        assert.equal(await shown(bea, root), domain, "once B's own lookup agrees, B shows it");
        await pretendDns(HOST, claim.record_name, []);
        await pretendDns(HOST_B, claim.record_name, []);
    });

    it('a domain pasted into any node finds whoever its record names (2026-10-20)', async () => {
        const ada = await makeUserFetch({ prefix: 'dompaa' });
        const root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        const { record_value: value } = await (await ada(`api/identity/${root}/domain`)).json();
        const bea = await makeUserFetch({ prefix: 'dompab', host: HOST_B });
        await bea('api/identity', { method: 'POST' });
        const ask = (url) => bea(`api/web-address?url=${encodeURIComponent(url)}`);

        // Proved by its record alone: the person, anywhere on the site, by their key.
        const own = domainFor('paste');
        await pretendDns(HOST_B, `_ringtome.${own}`, [value]);
        const found = await (await ask(`https://${own}/some/page`)).json();
        assert.equal(found.root, root, 'the record names them');
        assert.equal(found.endpoint, undefined, 'no node serves it: found by their key');

        // Served: its well-known file says by which node, the way to reach them.
        const served = domainFor('pasted');
        await pretendDns(HOST_B, `_ringtome.${served}`, [value]);
        await j(makeFetch(HOST_B), 'test/well-known', {
            domain: served,
            body: { root: value.split('=')[1], served: true, endpoint: 'abc123' },
        });
        const reached = await (await ask(`https://${served}/`)).json();
        assert.equal(reached.root, root);
        assert.equal(reached.endpoint, 'abc123', "the serving node's key rides along");

        // A site whose record names nobody finds nobody, whatever its website says.
        const nobody = domainFor('nobody');
        await j(makeFetch(HOST_B), 'test/well-known', {
            domain: nobody,
            body: { root: value.split('=')[1], served: true, endpoint: 'abc123' },
        });
        assert.equal((await ask(`https://${nobody}/`)).status, 404);

        for (const d of [own, served]) await pretendDns(HOST_B, `_ringtome.${d}`, []);
        for (const d of [served, nobody])
            await j(makeFetch(HOST_B), 'test/well-known', { domain: d });
    });
});

describe('custom domains: a proved domain is the persona’s own website', function () {
    this.timeout(60000);

    let ada, root, domain, post;
    // A request as the front sends it on: to this node, with the domain as its Host.
    const onDomain = (path, { method = 'GET', host } = {}) =>
        new Promise((resolve, reject) => {
            const [hostname, port] = HOST.split(':');
            const req = http.request(
                { hostname, port, path, method, headers: { host: host || domain } },
                (res) => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', (c) => (body += c));
                    res.on('end', () =>
                        resolve({ status: res.statusCode, headers: res.headers, body }),
                    );
                },
            );
            req.on('error', reject);
            req.end();
        });
    const owner = async () => (await ada(`api/identity/${root}/domain`)).json();

    before(async () => {
        ada = await makeUserFetch({ prefix: 'domsite' });
        await makeAdmin(ada);
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        // Never marked served (`/serve`): the app never asks for it, and hosting is enough.
        const draft = await (
            await j(ada, `api/identity/${root}/docs`, {
                title: 'Leek Soup',
                body: 'leeks',
                format: 'marquee',
            })
        ).json();
        post = (
            await (await j(ada, `api/identity/${root}/docs/${draft.doc_id}/publish`, {})).json()
        ).post_id;
        domain = domainFor('site');
    });

    after(async () => {
        await pretendDns(HOST, `_ringtome.${domain}`, []);
        await j(makeFetch(HOST), 'test/well-known', { domain });
    });

    it('a domain not yet proved is no one’s: the node answers it as itself', async () => {
        const claim = await (await j(ada, `api/identity/${root}/domain`, { domain }, 'PUT')).json();
        assert.equal(claim.serving, false);
        const page = await onDomain('/');
        assert.ok(!page.body.includes('name="ringtome-site"'), 'not their site');
    });

    it('once proved by TXT, the domain is their site: their page, their posts, their feed', async () => {
        const claim = await owner();
        await pretendDns(HOST, claim.record_name, [claim.record_value]);
        const proved = await (
            await ada(`api/identity/${root}/domain/check`, { method: 'POST' })
        ).json();
        assert.equal(proved.state, 'verified');
        assert.equal(proved.serving, true, 'proved by TXT, and served from here');

        const front = await onDomain('/');
        assert.equal(front.status, 200);
        assert.ok(
            front.body.includes('<meta name="ringtome-site" content="'),
            'the app is told whose',
        );
        assert.equal(front.headers['set-cookie'], undefined, 'a reading site sets no cookie');

        // A moment's patience for the node's label memo, as test/webpaths.cjs gives it.
        let soup = await onDomain('/leek-soup');
        for (let i = 0; i < 20 && soup.status !== 200; i++) {
            await new Promise((r) => setTimeout(r, 250));
            soup = await onDomain('/leek-soup');
        }
        assert.equal(soup.status, 200);
        assert.ok(
            soup.body.includes(`<meta name="ringtome:post" content="${root}/${post}">`),
            'the post’s own head',
        );
        assert.equal((await onDomain(`/post/${post}`)).status, 200, 'by its id too');
        assert.equal(
            (await onDomain('/no-such-thing')).status,
            404,
            'an old Hugo link: their page, under a 404',
        );

        for (const feed of ['/index.xml', '/feed.xml']) {
            const rss = await onDomain(feed);
            assert.equal(rss.status, 200, feed);
            assert.match(rss.body, /<rss/, feed);
        }
        const known = JSON.parse((await onDomain('/.well-known/ringtome')).body);
        assert.equal(known.served, true);
        assert.ok(known.root && root.length === 64, 'names the root');

        const listed = await (await makeFetch(HOST)('api/node/domains')).json();
        assert.ok(
            listed.domains.some((d) => d.domain === domain && d.root === root),
            'the front’s list',
        );
    });

    it('is a reading site: no writes, and the node’s own pages are the node’s', async () => {
        assert.equal((await onDomain('/api/identity', { method: 'POST' })).status, 403);
        const own = await onDomain(`/ringtome/user/${root}/leek-soup`);
        assert.equal(own.status, 308);
        assert.equal(
            own.headers.location,
            '/leek-soup',
            'their address in the node’s form comes home',
        );
        const sitemap = await onDomain('/sitemap.xml');
        if (sitemap.status === 200) assert.ok(sitemap.body.includes(`https://${domain}/leek-soup`));
        const robots = await onDomain('/robots.txt');
        assert.equal(robots.status, 200);
        assert.ok(
            robots.body.includes(`Sitemap: https://${domain}/sitemap.xml`) ||
                robots.body.includes('Disallow: /'),
        );
    });

    it('is the canonical address only once the domain says it’s served', async () => {
        assert.equal((await owner()).served_ms, null, 'nothing at the domain has said so yet');
        // What the front would hand any node that asked: this node's own answer, at the domain.
        const said = JSON.parse((await onDomain('/.well-known/ringtome')).body);
        await j(makeFetch(HOST), 'test/well-known', { domain, body: said });
        await ada(`api/identity/${root}/domain/check`, { method: 'POST' });
        assert.ok((await owner()).served_ms, 'served');

        // On the node serving it, the @name goes there - and only once it's served.
        const name = `domsite${Date.now() % 1000000}`;
        await j(ada, `api/identity/${root}/slug`, { slug: name }, 'PUT');
        const sent = await makeFetch(HOST)(`@${name}/leek-soup?x=1`, { redirect: 'manual' });
        assert.equal(sent.status, 307, 'temporary: a domain can lapse');
        assert.equal(sent.headers.get('location'), `https://${domain}/leek-soup?x=1`);

        // Canonical everywhere (slice 2): the head, the feed and "copy link" all say the domain.
        const stranger = makeFetch(HOST);
        const canonical = (page) => (/<link rel="canonical" href="([^"]*)">/.exec(page) || [])[1];
        const soup = await (await stranger(`ringtome/user/${root}/leek-soup`)).text();
        assert.equal(canonical(soup), `https://${domain}/leek-soup`);
        assert.ok(soup.includes(`<meta property="og:url" content="https://${domain}/leek-soup">`));
        const home = await (await stranger(`ringtome/user/${root}`)).text();
        assert.equal(canonical(home), `https://${domain}`);
        assert.equal(
            canonical((await onDomain('/leek-soup')).body),
            `https://${domain}/leek-soup`,
            'and at the domain itself',
        );
        assert.equal((await (await stranger(`api/node/slug-of/${root}`)).json()).domain, domain);
        const rss = await (await stranger(`ringtome/user/${root}/rss.xml`)).text();
        assert.ok(
            rss.includes(`<link>https://${domain}/leek-soup</link>`),
            'the feed links the domain',
        );

        // Back to the old site, which names them but isn't us: the ✓ stays, the address doesn't.
        await j(makeFetch(HOST), 'test/well-known', { domain, body: { root } });
        const back = await (
            await ada(`api/identity/${root}/domain/check`, { method: 'POST' })
        ).json();
        assert.equal(back.state, 'verified');
        assert.equal(back.served_ms, null);
        const after = await (await stranger(`ringtome/user/${root}/leek-soup`)).text();
        assert.match(
            canonical(after),
            /\/ringtome\/user\/[^/]+\/leek-soup$/,
            'the node’s own form again',
        );
        assert.equal((await (await stranger(`api/node/slug-of/${root}`)).json()).domain, null);
        const kept = await stranger(`@${name}/leek-soup`, { redirect: 'manual' });
        assert.equal(kept.status, 200, 'not served: the @name answers here again');
    });
});
