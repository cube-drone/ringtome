// The strike's reach into the feed, live: Alice on :5298 pairs a device on :5299; each
// device posts; both posts land in her own feed (self rows). The senior repudiates the
// device from genesis - the disowned post must leave the feed, the honest one stand.
import { inflateRawSync } from 'node:zlib';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const decodeCode = (code) => {
    const t = code.trim();
    if (t.startsWith('{')) return JSON.parse(t);
    return JSON.parse(inflateRawSync(Buffer.from(t.slice(4), 'base64url')).toString('utf8'));
};
const settle = async (fn, tries = 120) => {
    for (let i = 0; i < tries; i++) { const got = await fn(); if (got) return got; await sleep(250); }
    return null;
};

const a = session('http://localhost:5298');
await signUp(a, 'strike-senior');
const root = (await (await a.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const b = session('http://localhost:5299');
await signUp(b, 'strike-device');
const request = await (await b.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();
const leaf = decodeCode(request.code).leaf_pubkey;
const grant = await (await a.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J,
    body: JSON.stringify({ code: request.code }) })).json();
await b.fetch('/api/identity/adopt/complete', { method: 'POST', headers: J,
    body: JSON.stringify({ code: grant.code }) });

const post = async (s, title, body) => {
    const d = await (await s.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
        body: JSON.stringify({ title, body, format: 'plaintext' }) })).json();
    await s.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
};
await post(a, 'honest-post', 'always mine');
await post(b, 'doomed-post', 'from the disowned device');
await b.fetch(`/api/identity/${root}/sync`, { method: 'POST', headers: J });

const feedTitles = async () => {
    const f = await (await a.fetch(`/api/identity/${root}/feed`)).json();
    return (f.items || []).map((i) => i.title).sort();
};
const both = await settle(async () => {
    const t = await feedTitles();
    return t.includes('honest-post') && t.includes('doomed-post') ? t : null;
});
console.log('RESULT before the strike:', JSON.stringify(both));

const struck = await a.fetch(`/api/identity/${root}/keys/${leaf}/revoke`, { method: 'POST', headers: J,
    body: JSON.stringify({ disposition: 'repudiation', cut: 'genesis' }) });
console.log('RESULT strike status    :', struck.status);

const after = await settle(async () => {
    const t = await feedTitles();
    return t.includes('doomed-post') ? null : t;
});
console.log('RESULT after the strike :', JSON.stringify(after));
process.exit(0);
