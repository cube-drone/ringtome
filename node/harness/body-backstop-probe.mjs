// The gravedigger's rounds, end to end: B loses the two-hop body race (A1's body lane is
// lagged), then MISSES the poke (B is SIGSTOPped through the poke window) - the state the
// backstop exists for. After B resumes, nothing will ever dial it again for this persona;
// only its own missing-bodies sweep can heal it.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { session, signUp, sleep } from './boot.mjs';
const J = { 'Content-Type': 'application/json' };
const settle = async (fn, tries = 160) => {
    for (let i = 0; i < tries; i++) { const got = await fn(); if (got) return got; await sleep(250); }
    return null;
};

const a1 = session('http://localhost:5297');
await signUp(a1, 'grave-senior');
const root = (await (await a1.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
const a2 = session('http://localhost:5298');
await signUp(a2, 'grave-device');
const request = await (await a2.fetch('/api/identity/adopt/begin', { method: 'POST', headers: J })).json();
const grant = await (await a1.fetch(`/api/identity/${root}/nodes`, { method: 'POST', headers: J,
    body: JSON.stringify({ code: request.code }) })).json();
await a2.fetch('/api/identity/adopt/complete', { method: 'POST', headers: J,
    body: JSON.stringify({ code: grant.code }) });

const { toBase58 } = await import('../js/speakable.js');
const viaA1 = toBase58((await (await a1.fetch('/api/node')).json()).endpoint_id);
const bob = session('http://localhost:5299');
await signUp(bob, 'grave-bob');
const bobRoot = (await (await bob.fetch('/api/identity', { method: 'POST', headers: J })).json()).root_pubkey;
await bob.fetch(`/api/id/${root}/profile?via=${viaA1}`);
await bob.fetch(`/api/identity/${bobRoot}/private/kv/contact:${root}/interest`, {
    method: 'PUT', headers: J, body: JSON.stringify({ value: 'high' }) });
await sleep(2500);

const d = await (await a2.fetch(`/api/identity/${root}/docs`, { method: 'POST', headers: J,
    body: JSON.stringify({ title: 'Buried Lede', body: 'the body in question', format: 'plaintext' }) })).json();
const pub = await a2.fetch(`/api/identity/${root}/docs/${d.doc_id}/publish`, { method: 'POST', headers: J });
const postId = JSON.parse(await pub.text()).post_id;

// The header must reach B (journal row) while the body hasn't - then freeze B through the
// poke window so the event-driven heal misses entirely.
const row = await settle(async () => {
    const f = await (await bob.fetch(`/api/identity/${bobRoot}/feed`)).json();
    return (f.items || []).some((i) => i.author === root) ? true : null;
}, 24);
const early = await bob.fetch(`/id/${root}/docs/${postId}/body`);
console.log('RESULT header at B, body absent:', row === true, '/', early.status);

const pid = readFileSync('/tmp/ringtome-scratch-5299.pid', 'utf8').trim();
execSync(`kill -STOP ${pid}`);
console.log(`RESULT froze B (kill -STOP ${pid}) through the poke window`);
await sleep(30000); // A1's poke fires at ~+6s, fails against the frozen node, and gives up
execSync(`kill -CONT ${pid}`);
console.log(`RESULT resumed B (kill -CONT ${pid})`);

const body = await settle(async () => {
    const r = await bob.fetch(`/id/${root}/docs/${postId}/body`);
    return r.status === 200 ? await r.text() : null;
});
console.log('RESULT body after resume  :', JSON.stringify(body));
const log = readFileSync('/tmp/ringtome-scratch-5299.log', 'utf8');
console.log('RESULT healed by the sweep:', log.includes('recovered missing bodies on the sweep'));
process.exit(0);
