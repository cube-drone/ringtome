// The two-hop body race, made deterministic: A1 (the node Bob follows through) runs with
// RINGTOME_TEST_BODY_LAG_MS, so when the second device's post lands there as headers, A1
// pushes them onward to Bob BEFORE its own body backfill completes. Bob's first dial-back
// for bytes must find nothing - and Bob must still end up with the body, with no manual
// sync and no second post.
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const settle = async (fn, tries = 160) => {
    for (let i = 0; i < tries; i++) { const got = await fn(); if (got) return got; await sleep(250); }
    return null;
};

const a1 = session('http://localhost:5297');
await signUp(a1, 'hop-senior');
const root = (await (await a1.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;

const a2 = session('http://localhost:5298');
await signUp(a2, 'hop-device');
const request = await (await a2.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();
const grant = await (await a1.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J,
    body: JSON.stringify({ code: request.code }) })).json();
await a2.fetch('/api/identity/adopt/complete', { method: 'POST', headers: J,
    body: JSON.stringify({ code: grant.code }) });

const { toBase58 } = await import('../js/speakable.js');
const viaA1 = toBase58((await (await a1.fetch('/api/node')).json()).endpoint_id);
const bob = session('http://localhost:5299');
await signUp(bob, 'hop-bob');
const bobRoot = (await (await bob.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const seen = await bob.fetch(`/api/id/${root}/profile?via=${viaA1}`);
console.log('RESULT bob found alice via A1:', seen.status);
await bob.fetch(`/api/identity/${bobRoot}/private/kv/contact:${root}/interest`, {
    method: 'PUT', headers: J, body: JSON.stringify({ value: 'high' }) });
await settle(async () => {
    const f = await (await bob.fetch(`/api/identity/${bobRoot}/feed`)).json();
    return f.items !== undefined ? true : null;
});
await sleep(2000); // let the follow reach C's memo

// The post, from the SECOND device. Nothing after this line but watching.
const d = await (await a2.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Two Hops', body: 'written on the second device', format: 'plaintext' }) })).json();
const pub = await a2.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
const postId = JSON.parse(await pub.text()).post_id;

const row = await settle(async () => {
    const f = await (await bob.fetch(`/api/identity/${bobRoot}/feed`)).json();
    const items = (f.items || []).filter((i) => i.author === root);
    return items.length ? items : null;
});
console.log('RESULT feed row on B:', row ? `${row.length} row(s), title ${JSON.stringify(row[0]?.title)}` : 'NONE');
const early = await bob.fetch(`/id/${root}/docs/${postId}/body`);
console.log('RESULT body at journal time (race window):', early.status);

const body = await settle(async () => {
    const r = await bob.fetch(`/id/${root}/docs/${postId}/body`);
    return r.status === 200 ? await r.text() : null;
});
console.log('RESULT body eventually:', JSON.stringify(body));
process.exit(0);
